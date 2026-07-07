import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import streamChain from "stream-chain";
import streamJson from "stream-json";
import streamJsonPick from "stream-json/filters/Pick.js";
import streamJsonArray from "stream-json/streamers/StreamArray.js";
import { USER_AGENT } from "../version.js";

const { chain } = streamChain;
const { parser } = streamJson;
const { pick } = streamJsonPick;
const { streamArray } = streamJsonArray;

export type FeedFormat = "jsonl" | "json-envelope" | "json-array";

export interface FeedItem {
  index: number;
  value: unknown;
  /** Parse error for this record (JSONL only). */
  parseError?: string;
}

export interface FeedSource {
  format: FeedFormat;
  items: AsyncIterable<FeedItem>;
  target: string;
}

export class FeedInputError extends Error {}

async function openStream(target: string): Promise<Readable> {
  if (/^https?:\/\//.test(target)) {
    const res = await fetch(target, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/jsonl, application/x-ndjson, application/json",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new FeedInputError(`Fetching feed failed: HTTP ${res.status} ${res.statusText} for ${target}`);
    }
    if (!res.body) throw new FeedInputError(`Empty response body for ${target}`);
    return Readable.fromWeb(res.body as never);
  }
  return createReadStream(target);
}

/**
 * Peek up to `n` bytes without losing them: returns the head plus a stream
 * that replays head + remainder.
 */
async function peek(stream: Readable, n = 65536): Promise<{ head: Buffer; replay: Readable }> {
  const it = stream.iterator({ destroyOnReturn: false });
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < n) {
    const { value, done } = await it.next();
    if (done) break;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    chunks.push(buf);
    total += buf.length;
  }
  const head = Buffer.concat(chunks);
  async function* replayAll() {
    yield head;
    for await (const chunk of it) yield chunk;
  }
  return { head, replay: Readable.from(replayAll()) };
}

/** SPEC_NOTES §5: .jsonl/.ndjson (spec snapshot format), or .json envelope/array. */
export function detectFormatFromHead(head: string): FeedFormat {
  const trimmed = head.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("[")) return "json-array";
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { products?: unknown }).products)) {
      return "json-envelope"; // minified {"products":[...]} on one line
    }
    return "jsonl";
  } catch {
    return "json-envelope";
  }
}

async function* iterateJsonl(stream: Readable): AsyncIterable<FeedItem> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  for await (const line of rl) {
    const text = line.replace(/^\uFEFF/, "").trim();
    if (text === "") continue;
    try {
      yield { index, value: JSON.parse(text) };
    } catch (err) {
      yield { index, value: undefined, parseError: (err as Error).message };
    }
    index++;
  }
}

async function* iterateJsonProducts(stream: Readable, envelope: boolean): AsyncIterable<FeedItem> {
  const stages: unknown[] = [stream, parser()];
  if (envelope) stages.push(pick({ filter: "products" }));
  stages.push(streamArray());
  const pipeline = chain(stages as never) as unknown as AsyncIterable<{ key: number; value: unknown }>;
  try {
    for await (const entry of pipeline) {
      yield { index: entry.key, value: entry.value };
    }
  } catch (err) {
    throw new FeedInputError(`Feed is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Opens a feed from a URL or local path and returns a streamed iterator of
 * Product records. Never buffers the whole feed in memory.
 */
export async function openFeed(target: string): Promise<FeedSource> {
  const stream = await openStream(target);
  const { head, replay } = await peek(stream);
  if (head.length === 0) throw new FeedInputError(`Feed is empty: ${target}`);
  const headText = head.toString("utf8");

  const lower = target.split("?")[0]!.toLowerCase();
  let format: FeedFormat;
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) format = "jsonl";
  else if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".xml")) {
    throw new FeedInputError(
      'Only JSON formats are defined by the ACP Product Feed spec (products.jsonl snapshot, or a {"products": []} JSON document). CSV/TSV/XML are not supported. See SPEC_NOTES.md §5.'
    );
  } else format = detectFormatFromHead(headText);

  const items =
    format === "jsonl" ? iterateJsonl(replay) : iterateJsonProducts(replay, format === "json-envelope");
  return { format, items, target };
}
