import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { invokeOperation, releaseRepository } from "./operations.js";
import { serviceConfig } from "./background-service.js";
import { atomicWrite, sha256 } from "./io.js";
import { assertRootIdentity } from "./root-identity.js";
import { endVisualisations, waitVisualisationsClosed } from "./visualisation.js";
import { stopAgentRuns } from "./task-agents.js";
import { withFileLock } from "./io.js";

const path=resolve(process.argv[2]??""),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error("Invalid background host configuration.");
const config=JSON.parse(readFileSync(path,"utf8"));if(typeof config.home!=="string")throw new Error("Missing background host home.");process.env.RKE_USER_HOME=config.home;
const root=String(config.root),paths=serviceConfig(root);
if(path!==resolve(paths.path)||config.schemaVersion!==1)throw new Error("Invalid background host registration.");
assertRootIdentity(root,String(config.identity));
await withFileLock(paths.directory+"/running",async()=>{
 const result=await invokeOperation(root,"repo_visualisation_serve",config.args,{taskActor:"human"});
 const status={state:"running",pid:process.pid,identity:config.identity,configDigest:sha256(readFileSync(path)),url:result.payload.url,started:new Date().toISOString()};
 await atomicWrite(paths.status,JSON.stringify(status,null,2)+"\n");
 const stop=async()=>{await endVisualisations();await stopAgentRuns();};
 process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
 await waitVisualisationsClosed();await stopAgentRuns();await releaseRepository(root);await atomicWrite(paths.status,JSON.stringify({...status,state:"stopped"})+"\n");
 // The authenticated local server owns process lifetime. No model or Git sync is started here.
});
