import assert from "node:assert/strict";
import test from "node:test";

import { publicationDecision, tarballIntegrity } from "../src/release-publication.js";

test("release retry accepts only the exact previously published tarball",()=>{
  const integrity=tarballIntegrity(Buffer.from("tested tarball"));
  assert.equal(publicationDecision(404,undefined,integrity),"publish");
  assert.equal(publicationDecision(200,integrity,integrity),"already-published");
  assert.throws(()=>publicationDecision(200,tarballIntegrity(Buffer.from("different tarball")),integrity),/different tarball bytes/);
  assert.throws(()=>publicationDecision(200,undefined,integrity),/no comparable SHA-512 integrity/);
  assert.throws(()=>publicationDecision(503,undefined,integrity),/HTTP 503/);
});
