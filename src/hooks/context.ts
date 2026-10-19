#!/usr/bin/env node
import { contextHook } from "../context-hook.js";
import { hookRoot } from "../post-edit.js";
import { rootIdentity, withRootIdentity } from "../root-identity.js";

async function main(){const root=hookRoot(process.argv.slice(2));const payload=await withRootIdentity(root,rootIdentity(root),async()=>{let body="";for await(const chunk of process.stdin){body+=String(chunk);if(Buffer.byteLength(body)>65536)throw new Error("Input limit");}return contextHook(root,body.trim()?JSON.parse(body):{});});console.log(JSON.stringify(payload));}
main().catch(()=>console.log(JSON.stringify({result:"context-hook-unavailable",reason:"Use ordinary repository inspection."})));
