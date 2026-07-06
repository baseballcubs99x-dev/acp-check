import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { CATALOG } from "./catalog.js";
import type { BrokenScenario } from "./broken.js";

export interface MockMerchantOptions {
  port?: number;
  host?: string;
  /** Bearer token the server will accept. Default: "test_merchant_token". */
  authToken?: string;
  broken?: BrokenScenario[];
  apiVersion?: string;
}

export interface MockMerchant {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
  orders: string[];
}

interface Session {
  id: string;
  status: string;
  currency: string;
  items: { id: string; quantity: number }[];
  hasAddress: boolean;
  selectedFulfillment: boolean;
  canceled: boolean;
  completed: boolean;
  orderId?: string;
}

interface IdemRecord {
  bodyHash: string;
  response: { status: number; body: unknown };
}

const AUTH_DEFAULT = "test_merchant_token";

export async function startMockMerchant(opts: MockMerchantOptions = {}): Promise<MockMerchant> {
  const broken = new Set<BrokenScenario>(opts.broken ?? []);
  const authToken = opts.authToken ?? AUTH_DEFAULT;
  const apiVersion = opts.apiVersion ?? "2026-04-17";
  const sessions = new Map<string, Session>();
  const idempotency = new Map<string, IdemRecord>();
  const orders: string[] = [];

  const has = (b: BrokenScenario) => broken.has(b);

  function totalsFor(items: { id: string; quantity: number }[]) {
    const subtotal = items.reduce((sum, it) => sum + (CATALOG[it.id]?.unitAmount ?? 0) * it.quantity, 0);
    const tax = Math.round(subtotal * 0.0875);
    const shipping = 500;
    const total = subtotal + tax + shipping;
    const totals = [
      { type: "items_base_amount", display_text: "Item(s) total", amount: subtotal },
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      { type: "fulfillment", display_text: "Shipping", amount: shipping },
      { type: "tax", display_text: "Tax", amount: tax },
      { type: "total", display_text: "Total", amount: total },
    ];
    return has("missing-total") ? totals.filter((t) => t.type !== "total") : totals;
  }

  function lineItemsFor(items: { id: string; quantity: number }[]) {
    if (has("empty-line-items")) return [];
    return items.map((it, i) => {
      const cat = CATALOG[it.id];
      const base = (cat?.unitAmount ?? 0) * it.quantity;
      return {
        id: `li_${i}_${it.id}`,
        item: { id: it.id, name: cat?.name, unit_amount: cat?.unitAmount },
        quantity: it.quantity,
        name: cat?.name ?? it.id,
        unit_amount: cat?.unitAmount,
        totals: [
          { type: "items_base_amount", display_text: "Base", amount: base },
          { type: "subtotal", display_text: "Subtotal", amount: base },
          { type: "total", display_text: "Total", amount: base },
        ],
      };
    });
  }

  function fulfillmentOptions(session: Session) {
    if (has("no-fulfillment-options")) return [];
    if (!session.hasAddress) return [];
    return [
      {
        type: "shipping",
        id: "ship_standard",
        title: "Standard Shipping",
        description: "Arrives in 4–5 business days",
        carrier: "USPS",
        totals: [{ type: "fulfillment", display_text: "Shipping", amount: 500 }],
      },
      {
        type: "shipping",
        id: "ship_express",
        title: "Express Shipping",
        description: "Arrives in 1–2 business days",
        carrier: "UPS",
        totals: [{ type: "fulfillment", display_text: "Shipping", amount: 1500 }],
      },
    ];
  }

  function computeStatus(session: Session): string {
    if (session.completed) return "completed";
    if (session.canceled) return "canceled";
    if (has("never-ready")) return "not_ready_for_payment";
    if (session.hasAddress && session.selectedFulfillment) return "ready_for_payment";
    return "not_ready_for_payment";
  }

  function renderSession(session: Session, extra: Record<string, unknown> = {}): unknown {
    const base: Record<string, unknown> = {
      id: session.id,
      protocol: { version: apiVersion },
      status: has("invalid-schema-session") ? "totally_bogus_status" : computeStatus(session),
      currency: session.currency,
      line_items: lineItemsFor(session.items),
      totals: totalsFor(session.items),
      fulfillment_options: fulfillmentOptions(session),
      messages: [],
      links: [{ type: "terms_of_use", title: "Terms", url: "https://shop.example.com/terms" }],
      capabilities: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...extra,
    };
    if (session.hasAddress) {
      base.selected_fulfillment_options = session.selectedFulfillment
        ? [{ type: "shipping", option_id: "ship_standard", item_ids: (base.line_items as { id: string }[]).map((li) => li.id) }]
        : [];
    }
    return base;
  }

  function err(res: ServerResponse, status: number, code: string, message: string, param?: string) {
    if (has("html-errors")) {
      res.writeHead(status, { "content-type": "text/html" }).end(`<!doctype html><html><body><h1>${status} ${code}</h1><p>${message}</p></body></html>`);
      return;
    }
    if (has("bad-error-shape")) {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message, status }));
      return;
    }
    res.writeHead(status, { "content-type": "application/json" }).end(
      JSON.stringify({ type: "invalid_request", code, message, ...(param ? { param } : {}) })
    );
  }

  function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // ---- auth ----
      const authHeader = req.headers["authorization"];
      if (!has("no-auth")) {
        if (!authHeader) return err(res, 401, "unauthorized", "Authorization header is required.");
        if (!has("accept-any-token") && authHeader !== `Bearer ${authToken}`) {
          return err(res, 401, "unauthorized", "Invalid API token.");
        }
      }

      // ---- idempotency for POST ----
      const idemKey = req.headers["idempotency-key"] as string | undefined;
      const echoHeaders: Record<string, string> = {};
      if (method === "POST") {
        if (!idemKey && !has("no-idempotency-required")) {
          return err(res, 400, "idempotency_key_required", "Idempotency-Key header is required");
        }
        if (idemKey) echoHeaders["idempotency-key"] = idemKey;
      }

      let body: unknown;
      if (method === "POST" && raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          if (has("malformed-json-500")) return err(res, 500, "server_error", "boom");
          return err(res, 400, "invalid_json", "Request body is not valid JSON.");
        }
      }

      // idempotent replay handling for create/complete
      const idemScope = `${method}:${path}:${idemKey}`;
      if (method === "POST" && idemKey && !has("double-create") && !has("double-order")) {
        const prior = idempotency.get(idemScope);
        if (prior) {
          const bodyHash = JSON.stringify(body ?? {});
          if (prior.bodyHash !== bodyHash && !has("no-idempotency-conflict")) {
            return err(res, 422, "idempotency_conflict", "Idempotency-Key has already been used with a different request body");
          }
          if (prior.bodyHash === bodyHash) {
            return json(res, prior.response.status, prior.response.body, { ...echoHeaders, "idempotent-replayed": "true" });
          }
        }
      }

      const recordIdem = (status: number, responseBody: unknown) => {
        if (method === "POST" && idemKey) idempotency.set(idemScope, { bodyHash: JSON.stringify(body ?? {}), response: { status, body: responseBody } });
      };

      // ---- routes ----
      // POST /checkout_sessions
      if (path === "/checkout_sessions" && method === "POST") {
        const b = (body ?? {}) as { line_items?: { id: string; quantity?: number }[]; currency?: string; fulfillment_details?: { address?: unknown } };
        if (!b.currency) return err(res, 400, "missing_required_field", "currency is required", "$.currency");
        if (!Array.isArray(b.line_items) || b.line_items.length === 0)
          return err(res, 400, "missing_required_field", "line_items is required", "$.line_items");

        const items = b.line_items.map((li) => ({ id: li.id, quantity: li.quantity ?? 1 }));
        const unknown = items.find((it) => !CATALOG[it.id]);
        if (unknown) {
          if (has("sku-500")) return err(res, 500, "server_error", "unhandled");
          if (has("sku-silent")) {
            // return a clean session anyway (the bug)
          } else {
            return err(res, 400, "invalid_item_id", `The item ID '${unknown.id}' does not exist.`, "$.line_items[0].item.id");
          }
        }
        const outOfStock = items.find((it) => CATALOG[it.id] && !CATALOG[it.id]!.inStock);

        const session: Session = {
          id: `cs_${randomUUID()}`,
          status: "not_ready_for_payment",
          currency: b.currency,
          items,
          hasAddress: Boolean(b.fulfillment_details?.address),
          selectedFulfillment: false,
          canceled: false,
          completed: false,
        };
        sessions.set(session.id, session);

        const messages =
          outOfStock && !has("sku-silent")
            ? [{ type: "error", code: "out_of_stock", content_type: "plain", content: `${CATALOG[outOfStock.id]?.name} is out of stock.`, param: "$.line_items[0]" }]
            : [];
        const rendered = renderSession(session, { messages, status: outOfStock ? "not_ready_for_payment" : computeStatus(session) });
        const status = has("wrong-create-status") ? 200 : 201;
        recordIdem(status, rendered);
        return json(res, status, rendered, echoHeaders);
      }

      // /checkout_sessions/{id}[/complete|/cancel]
      const m = path.match(/^\/checkout_sessions\/([^/]+)(\/complete|\/cancel)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const sub = m[2];
        const session = sessions.get(id);

        if (method === "GET" && !sub) {
          if (!session) {
            if (has("unknown-session-200")) return json(res, 200, renderSession({ id, status: "incomplete", currency: "usd", items: [], hasAddress: false, selectedFulfillment: false, canceled: false, completed: false }));
            return err(res, 404, "not_found", "Session not found.");
          }
          return json(res, 200, renderSession(session));
        }
        if (!session) return err(res, 404, "not_found", "Session not found.");

        if (method === "POST" && !sub) {
          const b = (body ?? {}) as { fulfillment_details?: { address?: { country?: string; postal_code?: string } }; selected_fulfillment_options?: unknown[] };
          if (b.fulfillment_details?.address) {
            const addr = b.fulfillment_details.address;
            if (addr.country && addr.country.length !== 2) {
              return err(res, 400, "invalid_address", "country must be an ISO 3166-1 alpha-2 code.", "$.fulfillment_details.address.country");
            }
            session.hasAddress = true;
          }
          if (Array.isArray(b.selected_fulfillment_options) && b.selected_fulfillment_options.length > 0) {
            if (!session.hasAddress) session.hasAddress = true;
            session.selectedFulfillment = true;
          }
          const rendered = renderSession(session);
          recordIdem(200, rendered);
          return json(res, 200, rendered, echoHeaders);
        }

        if (method === "POST" && sub === "/cancel") {
          if (session.completed || session.canceled) {
            if (has("cancel-no-405")) return json(res, 200, renderSession(session));
            return err(res, 405, "not_cancelable", "Session is already completed or canceled.");
          }
          session.canceled = true;
          const rendered = renderSession(session);
          recordIdem(200, rendered);
          return json(res, 200, rendered, echoHeaders);
        }

        if (method === "POST" && sub === "/complete") {
          const b = (body ?? {}) as { payment_data?: unknown };
          if (!b.payment_data) return err(res, 400, "missing_required_field", "payment_data is required", "$.payment_data");
          const orderId = `ord_${randomUUID()}`;
          session.completed = true;
          session.orderId = orderId;
          orders.push(orderId);
          const order = {
            type: "order",
            id: orderId,
            checkout_session_id: session.id,
            permalink_url: `https://shop.example.com/orders/${orderId}`,
            status: "confirmed",
            line_items: (renderSession(session) as { line_items: { id: string; name?: string }[] }).line_items.map((li) => ({
              id: li.id,
              title: li.name ?? li.id,
              quantity: { ordered: 1, current: 1, fulfilled: 0 },
            })),
            totals: totalsFor(session.items),
          };
          const rendered = renderSession(session, { status: "completed", order });
          recordIdem(200, rendered);
          return json(res, 200, rendered, echoHeaders);
        }
      }

      return err(res, 404, "not_found", `No route for ${method} ${path}`);
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    server,
    orders,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((e) => (e ? reject(e) : resolvePromise()))),
  };
}
