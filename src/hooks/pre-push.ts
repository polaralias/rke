#!/usr/bin/env node
import { invokeOperation } from "../operations.js";
import { resolve } from "node:path";
const args=process.argv.slice(2);const rootIndex=args.indexOf("--root"),baseIndex=args.indexOf("--base");const root=rootIndex>=0?resolve(args[rootIndex+1]??process.cwd()):process.cwd();const base=baseIndex>=0?args[baseIndex+1]:undefined;const outcome=await invokeOperation(root,"workflow_closure_assess",base?{base}:{});console.log(JSON.stringify(outcome.payload));process.exitCode=outcome.exitCode;
