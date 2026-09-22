#!/usr/bin/env node
import { invokeOperation } from "../operations.js";
import { resolve } from "node:path";
const args=process.argv.slice(2);const index=args.indexOf("--root");const root=index>=0?resolve(args[index+1]??process.cwd()):process.cwd();const outcome=await invokeOperation(root,"workflow_activate",{});console.log(JSON.stringify(outcome.payload));process.exitCode=outcome.exitCode;
