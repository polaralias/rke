import { basename } from "node:path";
import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";
import { safeRelative } from "./paths.js";
import { projectReader } from "./reader-projection.js";
import { readerBodyExcerpt, validateReaderProjection, type ReaderProjection, type ReaderRecord, type ReaderRelationship } from "./reader.js";
import type { RepositoryEngine } from "./repository-engine.js";
import type { OperationContext, OperationOutcome } from "./types.js";
import { workspaceQuery } from "./workspace.js";

type Value=Record<string,unknown>;
type Engines=<T>(root:string,read:(engine:RepositoryEngine)=>Promise<T>)=>Promise<T>;
interface View {repository:string;projection:ReaderProjection}
interface Root {repository:string;status:string;omissions:number;snapshot:{head:string|null;inputDigest:string}|null}
const identity=(repository:string,id:string)=>`${repository}::${id}`;

/** The existing workspace session owns every root, scope and content recheck. */
export async function projectWorkspaceReader(owner:string,args:Value,context:OperationContext,engines:Engines):Promise<OperationOutcome>{
  const selected=String(args.selectedRepository),selection=safeRelative(String(args.selection)),comparison=args.comparison?safeRelative(String(args.comparison)):null,other=String(args.comparisonRepository??selected);
  if(args.comparisonRepository&&!comparison)throw new RkeError("reader_comparison_invalid","A comparison repository requires an explicit comparison path.",2);
  const result=await workspaceQuery(owner,"reader",{...args,limit:80,tokenBudget:16000},context,engines,{
    paths(repository){return repository===selected?[selection,...comparison&&other===selected?[comparison]:[]]:repository===other&&comparison?[comparison]:[];},
    project(root,repository,scopes,engine){return projectReader(root,{selection:repository===selected?selection:comparison!,comparison:repository===selected&&other===selected?comparison??undefined:undefined,bundle:(repository===selected?args.bundle:args.comparisonBundle) as string|undefined,includeExplanations:repository===selected?Boolean(args.includeExplanations):false,explanation:repository===selected?args.explanation as string|undefined:undefined,scopes},engine);}
  });
  const views=result.payload.views as View[],roots=result.payload.roots as Root[],primary=views.find(view=>view.repository===selected),secondary=views.find(view=>view.repository===other);
  // A failed primary cannot silently select another repository. A failed comparison remains visible in root status.
  const {views:_views,complete:workspaceComplete,...evidence}=result.payload;void _views;
  if(!primary)return{payload:{...evidence,workspaceComplete,complete:false,result:"workspace-reader-unavailable",projection:null},exitCode:3};
  const primaryId=identity(selected,primary.projection.selection.primary),comparisonId=other===selected?primary.projection.selection.comparison?identity(selected,primary.projection.selection.comparison):null:comparison&&secondary?identity(other,secondary.projection.selection.primary):null;
  const allRecords=new Map<string,ReaderRecord>();
  for(const view of views)for(const record of view.projection.records){const id=identity(view.repository,record.id);allRecords.set(id,{...record,id,repository:view.repository,details:[{label:"Repository",value:view.repository},{label:"Root snapshot",value:roots.find(root=>root.repository===view.repository)!.snapshot!.inputDigest},...record.details].slice(0,24)});}
  const ordered=[primaryId,...comparisonId?[comparisonId]:[]];
  // Selected records win first; remaining local ranks alternate rather than letting the first root fill the cap.
  for(let rank=0;rank<40;rank++)for(const view of views){const record=view.projection.records[rank];if(record)ordered.push(identity(view.repository,record.id));}
  const ids=[...new Set(ordered)],records:ReaderRecord[]=[];let bodyBytes=0;
  for(const id of ids.slice(0,40)){const record=allRecords.get(id)!,body=readerBodyExcerpt(record.body,262144-bodyBytes);bodyBytes+=Buffer.byteLength(body);records.push({...record,body,truncated:record.truncated||body!==record.body});}
  const included=new Set(records.map(record=>record.id)),localEdges:ReaderRelationship[]=views.flatMap(view=>view.projection.relationships.map(edge=>({...edge,source:identity(view.repository,edge.source),target:identity(view.repository,edge.target)}))),crossEdges:ReaderRelationship[]=[];
  let unresolved=0;
  for(const row of result.payload.rows as Value[]){
    if(row.kind!=="cross-root-dependency")continue;
    if(!row.consumer||!row.producer){unresolved++;continue;}
    const source=row.consumer as {repository:string;path:string},target=row.producer as {repository:string;path:string};
    const sourceId=identity(source.repository,source.path),targetId=identity(target.repository,target.path);
    if(!included.has(sourceId)||!included.has(targetId)||row.traversable!==true)unresolved++;
    crossEdges.push({source:sourceId,target:targetId,verb:`${row.dependencyKind}: ${row.resolution}`.slice(0,80),provenance:"inferred",certainty:"candidate"});
  }
  const knownEdges=[...new Map([...localEdges,...crossEdges].map(edge=>[JSON.stringify(edge),edge])).values()],relationships=knownEdges.filter(edge=>included.has(edge.source)&&included.has(edge.target)).slice(0,80);
  const omittedRecords=views.reduce((total,view)=>total+view.projection.coverage.omittedRecords,0)+Math.max(0,ids.length-records.length),omittedRelationships=views.reduce((total,view)=>total+view.projection.coverage.omittedRelationships,0)+knownEdges.length-relationships.length+Number(result.payload.omittedResults),excludedRecords=views.reduce((total,view)=>total+view.projection.coverage.excludedRecords,0),withheldExplanations=views.reduce((total,view)=>total+(view.projection.coverage.withheldExplanations??0),0);
  const workspace:NonNullable<ReaderProjection["workspace"]>={manifestDigest:String(result.payload.manifestDigest),snapshotPolicy:String(result.payload.snapshotPolicy),roots:roots.map(root=>({repository:root.repository,status:root.status,selected:root.repository===selected||Boolean(comparison&&root.repository===other),omissions:root.omissions,snapshot:root.snapshot?{head:root.snapshot.head,inputDigest:root.snapshot.inputDigest}:null}))};
  const coverage={omittedRecords,omittedRelationships,excludedRecords,withheldExplanations,bodyBytes,complete:result.exitCode===0&&!unresolved&&views.every(view=>view.projection.coverage.complete)&&records.every(record=>!record.truncated)&&!omittedRecords&&!omittedRelationships&&!excludedRecords&&!withheldExplanations};
  const projection:ReaderProjection={schemaVersion:1,repository:basename(owner),revision:sha256(JSON.stringify({workspace,views:views.map(view=>[view.repository,view.projection.revision]),records,relationships})),selection:{primary:primaryId,comparison:comparisonId},records,relationships,coverage,workspace};
  validateReaderProjection(projection);
  return{payload:{...evidence,workspaceComplete,complete:coverage.complete,result:"workspace-reader-projected",projection},exitCode:coverage.complete?0:3};
}
