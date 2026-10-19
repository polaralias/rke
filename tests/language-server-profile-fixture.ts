import { mkdtemp,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import type { TestContext } from "node:test";

export async function mockServerProfile(t:TestContext):Promise<{id:string;config:string;implementation:string}>{
  const directory=await mkdtemp(join(tmpdir(),"rke-trusted-lsp-profile-")),config=join(directory,"profiles.json");
  const implementation=join(directory,"semantic-server.mjs");
  const {copyFile}=await import("node:fs/promises");
  await copyFile(resolve("tests/fixtures/semantic-server.mjs"),implementation);
  await writeFile(config,JSON.stringify({schemaVersion:1,profiles:{mock:{command:process.execPath,args:[implementation],language:"typescript",implementationInputs:[implementation]}}}));
  const previous=process.env.RKE_LANGUAGE_SERVER_PROFILES;process.env.RKE_LANGUAGE_SERVER_PROFILES=config;
  t.after(()=>{if(previous===undefined)delete process.env.RKE_LANGUAGE_SERVER_PROFILES;else process.env.RKE_LANGUAGE_SERVER_PROFILES=previous;});
  return{id:"mock",config,implementation};
}
