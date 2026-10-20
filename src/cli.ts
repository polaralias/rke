#!/usr/bin/env node
import { selectManagedWorkspace } from "./managed-workspaces.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { asError, RkeError } from "./errors.js";
import { CLI_ROUTES } from "./cli-routes.js";
import { invokeOperation, OPERATIONS } from "./operations.js";
import { VERSION } from "./version.js";
import { endLiveReaders } from "./reader-live.js";

function liveSignals(){for(const [signal,code] of [["SIGINT",130],["SIGTERM",143]] as const)process.once(signal,()=>{void endLiveReaders().then(()=>{process.exitCode=code;process.stdin.pause();});});}

const KEYS:Record<string,string>={"related-bundle":"additionalBundles","task-mode":"taskMode","new-cycle":"newCycle","next-action":"nextAction","task-ref":"taskRef","changed":"changedPaths","reviewed-path":"reviewedPaths","reviewed-document":"reviewedDocuments","source":"sources","knowledge":"knowledgePaths","reader-query":"readerQueries","reference":"references","scope":"scopes","review-file":"reviewFile"};
const ARRAYS=new Set(["additionalBundles","capability","gate","changedPaths","reviewedPaths","reviewedDocuments","sources","knowledgePaths","readerQueries","references","verification","risks","changes","scopes","repositories"]);
const BOOLEANS=new Set(["force","newCycle","graphOnly","postEdit","sourceOnly","includeExplanations","includeEvidence","mergeBase","owners","contextHooks"]);
const NUMBERS=new Set(["limit","depth","tokenBudget","revision"]);

function usage():never{throw new RkeError("usage","Usage: rke <command> [subcommand] [arguments] [--root PATH]",2);}
function help(argv:string[]):number{
  const tokens=argv.filter(token=>token!=="help"&&token!=="--help"),prefix=tokens.slice(0,tokens.findIndex(token=>token.startsWith("--"))<0?tokens.length:tokens.findIndex(token=>token.startsWith("--"))).join(" ");
  const selected=Object.entries(CLI_ROUTES).filter(([command])=>!prefix||command===prefix||command.startsWith(`${prefix} `));
  if(!selected.length)usage();
  const commands=selected.map(([command,route])=>({command,operation:route.operation,positionals:route.positionals??[],...command===prefix?{inputSchema:OPERATIONS.find(operation=>operation.name===route.operation)!.inputSchema}:{} }));
  console.log(JSON.stringify({result:"rke-help",version:VERSION,usage:"rke <command> [arguments] (--root <repository> | --workspace <id> [--member <alias>])",commands,argumentAliases:KEYS,repeatableArguments:[...ARRAYS],details:"Use rke <command> --help for its shared CLI/MCP input schema. Camel-case schema keys map to kebab-case flags, with aliases shown here. Specify --root explicitly for repository operations; help does not open a repository."},null,2));
  return 0;
}
async function main():Promise<number>{const argv=process.argv.slice(2);if(argv.includes("--help")||argv[0]==="help")return help(argv);if(argv.includes("--version")||argv[0]==="version"){console.log(VERSION);return 0;}let selected:[string,(typeof CLI_ROUTES)[string]]|undefined;for(const entry of Object.entries(CLI_ROUTES).sort((a,b)=>b[0].split(" ").length-a[0].split(" ").length)){const tokens=entry[0].split(" ");if(tokens.every((token,index)=>argv[index]===token)){selected=entry;break;}}if(!selected)usage();const [routeKey,route]=selected;const rest=argv.slice(routeKey.split(" ").length);const args:Record<string,unknown>={};let workspaceId:string|undefined,member:string|undefined,explicitRoot=false;const allowedRoots:string[]=[];let root=process.cwd();let positional=0;for(let index=0;index<rest.length;index++){const token=rest[index]!;if(token.startsWith("--")){const raw=token.slice(2);const key=KEYS[raw]??raw.replace(/-([a-z])/g,(_m,c:string)=>c.toUpperCase());if(raw==="workspace"){workspaceId=rest[++index]??usage();continue;}if(raw==="member"){member=rest[++index]??usage();continue;}if(raw==="members-file"||raw==="bases-file"){args[raw==="members-file"?"members":"bases"]=JSON.parse(await readFile(resolve(root,rest[++index]??usage()),"utf8"));continue;}if(raw==="root"){explicitRoot=true;root=resolve(rest[++index]??usage());continue;}if(raw==="allow-root"){allowedRoots.push(resolve(rest[++index]??usage()));continue;}if(BOOLEANS.has(key)){args[key]=true;continue;}const next=rest[++index];if(next===undefined)usage();const converted=NUMBERS.has(key)?Number(next):next;if(ARRAYS.has(key)){const values=args[key] as unknown[]|undefined;args[key]=[...(values??[]),converted];}else args[key]=converted;}else{const name=route.positionals?.[positional++];if(!name)usage();args[name]=token;}}
  if(routeKey==="knowledge graph")args.graphOnly=true;
  if(args.reviewFile){args.review=JSON.parse(await readFile(resolve(root,String(args.reviewFile)),"utf8"));delete args.reviewFile;}
  if(args.scopes&&route.operation==="repo_find_context"){args.scope=(args.scopes as string[])[0];delete args.scopes;}
  if(args.scopes&&route.operation==="repo_tracker_preview"){
    const scopes=args.scopes as string[];
    if(scopes.length!==1)throw new RkeError("invalid_operation_arguments","tracker preview requires exactly one --scope",2);
    args.scope=scopes[0];delete args.scopes;
  }
  if(args.capability&&route.operation==="workflow_start"){args.capabilities=args.capability;delete args.capability;}if(args.gate&&route.operation==="workflow_start"){args.gates=args.gate;delete args.gate;}if(args.gate&&route.operation==="workflow_gate_add"){args.gates=args.gate;delete args.gate;}
  if(args.gate&&route.operation==="workflow_gate_resolve"){args.gate=(args.gate as string[])[0];}
  if(args.knowledgePaths&&route.operation==="repo_knowledge_verify"){args.knowledge=(args.knowledgePaths as string[])[0];delete args.knowledgePaths;}if(args.knowledgePaths&&route.operation==="repo_knowledge_register"){args.knowledge=(args.knowledgePaths as string[])[0];delete args.knowledgePaths;}
  if(["repo_view_serve","workspace_view_serve"].includes(route.operation))liveSignals();
  if(workspaceId){if(explicitRoot)throw new RkeError("workspace_selector_conflict","Use --workspace or --root, not both.",2);root=selectManagedWorkspace(workspaceId).root;}else if(member)throw new RkeError("workspace_selector_conflict","--member requires --workspace.",2);
  const outcome=await invokeOperation(root,route.operation,args,{allowedRoots,...workspaceId?{selectedWorkspace:workspaceId}:{},...member?{member}:{}});console.log(JSON.stringify(outcome.payload,null,2));return outcome.exitCode;}

main().then(code=>{process.exitCode=code;}).catch(error=>{const value=asError(error);const typed=error instanceof RkeError?error:new RkeError("internal_error",value.message,1);console.error(JSON.stringify({result:"error",error:{code:typed.code,message:typed.message}},null,2));process.exitCode=typed.exitCode;});
