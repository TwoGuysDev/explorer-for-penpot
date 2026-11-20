import assert from "node:assert/strict";
import { test } from "node:test";
import { PenpotApi, PenpotError, ROOT_ID, isAnonymous } from "../api";

type Call = { url: string; init?: RequestInit };

/** A fake fetch that answers from a table of URL fragments. */
function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [frag, make] of Object.entries(routes)) if (url.includes(frag)) return make();
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("sends the command as JSON with the token", async () => {
  const calls: Call[] = [];
  const api = new PenpotApi("https://penpot.test", "secret", fakeFetch({ "/get-teams": () => json([{ id: "t1", name: "Team" }]) }, calls));
  const teams = await api.getTeams();
  assert.equal(teams[0].name, "Team");
  assert.equal(calls[0].url, "https://penpot.test/api/rpc/command/get-teams");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as any).Authorization, "Token secret");
  assert.equal((calls[0].init?.headers as any).Accept, "application/json");
});

test("passes objectId only when given", async () => {
  const calls: Call[] = [];
  const api = new PenpotApi("https://penpot.test", "t", fakeFetch({ "/get-page": () => json({ id: "p", name: "Page", objects: {} }) }, calls));
  await api.getPage("f", "p");
  await api.getPage("f", "p", "o");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { fileId: "f", pageId: "p" });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { fileId: "f", pageId: "p", objectId: "o" });
});

test("maps authentication errors", async () => {
  const api = new PenpotApi("https://penpot.test", "bad", fakeFetch({ "/get-teams": () => json({ type: "authentication", code: "authentication-required" }, 401) }));
  await assert.rejects(api.getTeams(), (e: unknown) => e instanceof PenpotError && e.kind === "auth");
});

test("reports connection failures with the cause", async () => {
  const api = new PenpotApi("https://nowhere.test", "t", fakeFetch({}));
  await assert.rejects(api.getTeams(), (e: unknown) => e instanceof PenpotError && e.kind === "connection" && /ECONNREFUSED/.test(e.message));
});

test("retries localhost on 127.0.0.1", async () => {
  const calls: Call[] = [];
  const api = new PenpotApi("http://localhost:9001", "t", fakeFetch({ "127.0.0.1:9001/api/rpc/command/get-profile": () => json({ id: "u1", fullname: "Ana" }) }, calls));
  const me = await api.getProfile();
  assert.equal(me.fullname, "Ana");
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["localhost", "127.0.0.1"]);
  // links for the browser keep the configured address
  assert.match(api.workspaceUrl("t", "f"), /^http:\/\/localhost:9001\//);
});

test("detects the anonymous profile Penpot returns for unknown tokens", () => {
  assert.equal(isAnonymous({ id: ROOT_ID, fullname: "Anonymous User" }), true);
  assert.equal(isAnonymous({ id: "8b3d…" }), false);
  assert.equal(isAnonymous(undefined), true);
});

test("builds workspace links", () => {
  const api = new PenpotApi("https://design.penpot.app", "t", fakeFetch({}));
  assert.equal(api.workspaceUrl("T", "F", "P", "B"), "https://design.penpot.app/#/workspace?team-id=T&file-id=F&page-id=P&board-id=B");
  assert.equal(api.workspaceUrl("T", "F"), "https://design.penpot.app/#/workspace?team-id=T&file-id=F");
});

test("downloads assets as data URIs", async () => {
  const api = new PenpotApi("https://penpot.test", "t", fakeFetch({ "/assets/by-file-media-id/m1": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) }));
  assert.equal(await api.fileMediaDataUri("m1"), "data:image/png;base64,AQID");
  assert.equal(await api.fileMediaDataUri("missing"), undefined);
});
