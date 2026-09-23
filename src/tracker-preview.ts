import { readFile } from "node:fs/promises";
import YAML from "yaml";

import { repositoryPath, safeRelative } from "./paths.js";
import type { OperationOutcome } from "./types.js";

interface PackageRecord {
  id:string;title:string;summary:string;parent?:string;acceptance:string[];
  dependsOn?:string[];priority?:string;labels?:string[];implementationNotes?:string;
}

function isText(value:unknown):value is string{return typeof value==="string"&&value.trim().length>0;}
function textList(value:unknown):value is string[]{return Array.isArray(value)&&value.length>0&&value.every(isText);}
function optionalTextList(value:unknown):value is string[]|undefined{return value===undefined||(Array.isArray(value)&&value.every(isText));}

export async function trackerPreview(root:string,packagesPath:string,tracker:string,scope:string):Promise<OperationOutcome>{
  const source=safeRelative(packagesPath),target=repositoryPath(root,source);
  let input:unknown;try{input=YAML.parse(await readFile(target,"utf8"),{uniqueKeys:true});}catch(error){return{exitCode:2,payload:{result:"tracker-preview-invalid",source,error:String(error),publication:"not performed"}};}
  if(!input||typeof input!=="object"||Array.isArray(input))return{exitCode:2,payload:{result:"tracker-preview-invalid",source,errors:["Package source must be a mapping."],publication:"not performed"}};
  const document=input as Record<string,unknown>,records=document.packages;
  const errors:string[]=[];
  if(document.schemaVersion!==1)errors.push("schemaVersion must be 1");
  if(document.status!=="accepted")errors.push("Package set must be accepted before tracker mapping.");
  if(!Array.isArray(records)||!records.length)errors.push("At least one accepted package is required.");
  if(!isText(tracker)||!isText(scope)||tracker.length>100||scope.length>200||/[\r\n]/.test(tracker+scope))errors.push("Explicit bounded tracker and destination scope are required for a preview.");
  const packages=(Array.isArray(records)?records:[]) as Record<string,unknown>[];
  const ids=new Set<string>();
  for(const item of packages){
    if(!item||typeof item!=="object"||Array.isArray(item)){errors.push("Each package must be a mapping.");continue;}
    const id=item.id;
    if(!isText(id)||!/^[-._A-Za-z0-9]+$/.test(id))errors.push("Each package needs a stable safe ID.");
    else if(ids.has(id))errors.push(`Duplicate package ID: ${id}.`);else ids.add(id);
    if(!isText(item.title)||!isText(item.summary))errors.push(`Package ${String(id)} needs title and summary.`);
    if(!textList(item.acceptance))errors.push(`Package ${String(id)} needs explicit acceptance.`);
    if(!optionalTextList(item.dependsOn)||!optionalTextList(item.labels))errors.push(`Package ${String(id)} has invalid dependencies or labels.`);
    if(item.parent!==undefined&&!isText(item.parent))errors.push(`Package ${String(id)} has invalid parent.`);
    if(item.priority!==undefined&&!isText(item.priority))errors.push(`Package ${String(id)} has invalid priority.`);
    if(item.implementationNotes!==undefined&&!isText(item.implementationNotes))errors.push(`Package ${String(id)} has invalid implementation notes.`);
  }
  for(const item of packages){
    if(!item||typeof item!=="object"||Array.isArray(item)||!isText(item.id))continue;
    if(item.parent!==undefined&&(!ids.has(String(item.parent))||item.parent===item.id))errors.push(`Package ${item.id} has unresolved or self parent.`);
    for(const dependency of Array.isArray(item.dependsOn)?item.dependsOn:[])if(!ids.has(String(dependency))||dependency===item.id)errors.push(`Package ${item.id} has unresolved or self dependency: ${String(dependency)}.`);
  }
  const parents=new Map(packages.filter(item=>item&&typeof item==="object"&&!Array.isArray(item)&&isText(item.id)).map(item=>[String(item.id),String(item.parent??"")]));
  for(const id of ids){const seen=new Set<string>();let current=id;while(parents.get(current)){current=parents.get(current)!;if(seen.has(current)||current===id){errors.push(`Parent cycle involving ${id}.`);break;}seen.add(current);}}
  const dependencies=new Map(packages.filter(item=>item&&typeof item==="object"&&isText(item.id)).map(item=>[String(item.id),Array.isArray(item.dependsOn)?item.dependsOn.map(String):[]]));
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string):void=>{if(visiting.has(id)){errors.push(`Dependency cycle involving ${id}.`);return;}if(visited.has(id))return;visiting.add(id);for(const dependency of dependencies.get(id)??[])if(dependencies.has(dependency))visit(dependency);visiting.delete(id);visited.add(id);};
  for(const id of ids)visit(id);
  if(errors.length)return{exitCode:3,payload:{result:"tracker-preview-invalid",source,errors,publication:"not performed"}};
  const rows=(packages as unknown as PackageRecord[]).map(item=>({sourceId:item.id,sourcePath:source,tracker,scope,title:item.title,summary:item.summary,parentSourceId:item.parent??null,parentTargetId:null,acceptance:item.acceptance,dependsOnSourceIds:item.dependsOn??[],dependencyTargetIds:[],priority:item.priority??null,labels:item.labels??[],implementationNotes:item.implementationNotes??null,unresolved:[...(item.parent?["target parent ID requires provider readback"]:[]),...((item.dependsOn??[]).length?["target dependency IDs require provider readback"]:[])]}));
  return{exitCode:0,payload:{result:"tracker-preview-rendered",source,tracker,scope,sourceKind:"accepted-work-packages",rows,publication:"not performed",externalIds:[],tasksCreated:false}};
}
