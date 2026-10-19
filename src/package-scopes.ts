import { posix } from "node:path";

const MANIFESTS=new Set(["package.json","go.mod","pyproject.toml","Cargo.toml","pom.xml","build.gradle","build.gradle.kts"]);
/** Git-visible package manifests identify ranking scopes; their contents never select tools. */
export function packageScopes(paths:string[]):string[]{
  return [...new Set(paths.filter(path=>MANIFESTS.has(posix.basename(path))).map(path=>posix.dirname(path)).filter(path=>path!=="."))].sort((a,b)=>b.length-a.length||a.localeCompare(b));
}
export function scopeFor(path:string,scopes:string[]):string{return scopes.find(scope=>path===scope||path.startsWith(`${scope}/`))??".";}
export function balanceScopes<T extends {path:unknown}>(rows:T[],scopes:string[]):T[]{
  if(!scopes.length)return rows;
  const groups=new Map<string,T[]>();
  for(const row of rows){const key=scopeFor(String(row.path),scopes),group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  const result:T[]=[];
  while([...groups.values()].some(group=>group.length))for(const group of groups.values()){const next=group.shift();if(next)result.push(next);}
  return result;
}
