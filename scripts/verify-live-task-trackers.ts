import { discover, requestJson } from "../src/tasks/trackers.js";
import type { Fields } from "../src/tasks/store.js";

/** Explicitly read-only qualification. No creation, update, publication or credential persistence. */
const systems=["github","gitlab","linear","clickup"],credentials:Record<string,string>={github:"GITHUB_TOKEN",gitlab:"GITLAB_TOKEN",linear:"LINEAR_API_KEY",clickup:"CLICKUP_API_TOKEN"};
const results:Fields[]=[];
for(const system of systems){
  const prefix=`RKE_LIVE_${system.toUpperCase()}`,scope=process.env[`${prefix}_SCOPE`],name=process.env[`${prefix}_TOKEN_ENV`]??credentials[system]!,apiBase=process.env[`${prefix}_API_BASE`];
  if(!scope||!process.env[name]){results.push({system,result:"unavailable",reason:!scope?"No explicit live read-only scope configured.":"No native runtime credential available."});continue;}
  try{const discovery=await discover(system,scope,{tokenEnv:name,...apiBase?{apiBase}:{}},async(url,headers,payload,method)=>{
    if(system==="linear"){if(method&&method!=="POST"||!String(payload?.query??"").startsWith("query "))throw new Error("Only GraphQL discovery queries are permitted.");}
    else if(payload||method&&method!=="GET")throw new Error("Only provider discovery GETs are permitted.");
    return requestJson(url,headers,payload,method);
  });results.push({system,result:"discovery-verified",scope:discovery.scope,statuses:(discovery.statuses as unknown[]).length,host:discovery.host,mutations:0});}
  catch{results.push({system,result:"failed",reason:"Read-only provider discovery failed; inspect the configured scope and credential locally.",mutations:0});}
}
if(process.argv.includes("--public-github")){
  const name="RKE_PUBLIC_DISCOVERY_PROBE",previous=process.env[name];process.env[name]="anonymous-read-only";
  try{const discovery=await discover("github","emanuele-em/kanzo",{tokenEnv:name},async(url,headers,payload,method)=>{
    if(payload||method&&method!=="GET"||new URL(url).origin!=="https://api.github.com")throw new Error("Public discovery is GET-only on GitHub.");
    const safe={...headers};delete safe.Authorization;return requestJson(url,safe);
  });results.push({system:"github",authentication:"anonymous",result:"public-discovery-verified",scope:discovery.scope,mutations:0});}
  catch{results.push({system:"github",authentication:"anonymous",result:"public-discovery-failed",mutations:0});}
  finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
}
console.log(JSON.stringify({results,scope:"Discovery only; authenticated create/import/sync live qualification is not established.",complete:systems.every(system=>results.some(result=>result.system===system&&result.result==="discovery-verified"))},null,2));
if(results.some(result=>result.result==="failed"))process.exitCode=1;
else if(!systems.every(system=>results.some(result=>result.system===system&&result.result==="discovery-verified")))process.exitCode=3;
