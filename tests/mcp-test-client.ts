import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Real MCP clients initialize before timing tool calls; keep the two bounds separate. */
export function mcpTestClient(child:ChildProcessWithoutNullStreams,requestTimeoutMs=15_000,startupTimeoutMs=60_000){
  const lines=createInterface({input:child.stdout});child.stderr.resume();
  const pending=new Map<number,{accept:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let next=0;
  const fail=(error:Error)=>{for(const row of pending.values()){clearTimeout(row.timer);row.reject(error);}pending.clear();};
  child.once("error",fail);child.once("exit",()=>{fail(new Error("MCP process exited before response"));lines.close();});
  lines.on("line",line=>{
    let row:Record<string,unknown>;try{row=JSON.parse(line) as Record<string,unknown>;}catch{fail(new Error("Invalid MCP response"));return;}
    if(typeof row.id!=="number")return;
    const waiter=pending.get(row.id);if(!waiter)return;
    clearTimeout(waiter.timer);pending.delete(row.id);
    if(row.error)waiter.reject(new Error("MCP returned a protocol error"));else waiter.accept(row);
  });
  const request=(method:string,params:Record<string,unknown>,timeout:number)=>new Promise<Record<string,unknown>>((accept,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP ${method} timeout`));},timeout);
    pending.set(id,{accept,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n",error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
  return {
    async initialize(){
      await request("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"rke-tests",version:"1"}},startupTimeoutMs);
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
    },
    call:(name:string,args:Record<string,unknown>)=>request("tools/call",{name,arguments:args},requestTimeoutMs),
    close(){lines.close();fail(new Error("MCP client closed"));}
  };
}
