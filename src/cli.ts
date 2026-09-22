#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { asError, RkeError } from "./errors.js";
import { CLI_ROUTES } from "./cli-routes.js";
import { invokeOperation } from "./operations.js";
import { VERSION } from "./version.js";

const KEYS:Record<string,string>={"task-mode":"taskMode","new-cycle":"newCycle","next-action":"nextAction","task-ref":"taskRef","changed":"changedPaths","source":"sources","knowledge":"knowledgePaths","reader-query":"readerQueries","reference":"references","scope":"scopes","review-file":"reviewFile"};
const ARRAYS=new Set(["capability","gate","changedPaths","sources","knowledgePaths","readerQueries","references","scopes"]);
const BOOLEANS=new Set(["force","newCycle"]);
const NUMBERS=new Set(["limit","depth"]);

function usage():never{throw new RkeError("usage","Usage: rke <command> [subcommand] [arguments] [--root PATH]",2);}
async function main():Promise<number>{const argv=process.argv.slice(2);if(argv.includes("--version")||argv[0]==="version"){console.log(VERSION);return 0;}let selected:[string,(typeof CLI_ROUTES)[string]]|undefined;for(const entry of Object.entries(CLI_ROUTES).sort((a,b)=>b[0].split(" ").length-a[0].split(" ").length)){const tokens=entry[0].split(" ");if(tokens.every((token,index)=>argv[index]===token)){selected=entry;break;}}if(!selected)usage();const [routeKey,route]=selected;const rest=argv.slice(routeKey.split(" ").length);const args:Record<string,unknown>={};let root=process.cwd();let positional=0;for(let index=0;index<rest.length;index++){const token=rest[index]!;if(token.startsWith("--")){const raw=token.slice(2);const key=KEYS[raw]??raw.replace(/-([a-z])/g,(_m,c:string)=>c.toUpperCase());if(raw==="root"){root=resolve(rest[++index]??usage());continue;}if(BOOLEANS.has(key)){args[key]=true;continue;}const next=rest[++index];if(next===undefined)usage();const converted=NUMBERS.has(key)?Number(next):next;if(ARRAYS.has(key)){const values=args[key] as unknown[]|undefined;args[key]=[...(values??[]),converted];}else args[key]=converted;}else{const name=route.positionals?.[positional++];if(!name)usage();args[name]=token;}}
  if(args.reviewFile){args.review=JSON.parse(await readFile(resolve(root,String(args.reviewFile)),"utf8"));delete args.reviewFile;}
  if(args.scopes&&route.operation==="repo_find_context"){args.scope=(args.scopes as string[])[0];delete args.scopes;}
  if(args.capability&&route.operation==="workflow_start"){args.capabilities=args.capability;delete args.capability;}if(args.gate&&route.operation==="workflow_start"){args.gates=args.gate;delete args.gate;}if(args.gate&&route.operation==="workflow_gate_add"){args.gates=args.gate;delete args.gate;}
  if(args.gate&&route.operation==="workflow_gate_resolve"){args.gate=(args.gate as string[])[0];}
  if(args.knowledgePaths&&route.operation==="repo_knowledge_verify"){args.knowledge=(args.knowledgePaths as string[])[0];delete args.knowledgePaths;}if(args.knowledgePaths&&route.operation==="repo_knowledge_register"){args.knowledge=(args.knowledgePaths as string[])[0];delete args.knowledgePaths;}
  const outcome=await invokeOperation(root,route.operation,args);console.log(JSON.stringify(outcome.payload,null,2));return outcome.exitCode;}

main().then(code=>{process.exitCode=code;}).catch(error=>{const value=asError(error);const typed=error instanceof RkeError?error:new RkeError("internal_error",value.message,1);console.error(JSON.stringify({result:"error",error:{code:typed.code,message:typed.message}},null,2));process.exitCode=typed.exitCode;});
