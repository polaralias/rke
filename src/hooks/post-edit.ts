#!/usr/bin/env node
import { hookContext, hookRoot, postEdit } from "../post-edit.js";
import { rootIdentity, withRootIdentity } from "../root-identity.js";

async function main(){const root=hookRoot(process.argv.slice(2));const payload=await withRootIdentity(root,rootIdentity(root),async()=>{let body="";for await(const chunk of process.stdin){body+=String(chunk);if(Buffer.byteLength(body)>65536)throw new Error("Hook input exceeds the 64 KiB limit.");}const input=body.trim()?JSON.parse(body):{};return hookContext(await postEdit(root,input));});console.log(JSON.stringify(payload));}
main().catch(()=>{console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"RKE post-edit evidence unavailable; use ordinary source review and validation."}}));});
