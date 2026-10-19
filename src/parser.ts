import { access } from "node:fs/promises";
import { extname, posix } from "node:path";
import { createRequire } from "node:module";

import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import YAML from "yaml";

import { sha256 } from "./io.js";
import type { ParsedChunk, ParsedFile, ParsedImport, ParsedSymbol } from "./types.js";

export const EXTRACTOR_VERSION = "ts-0.1.0-wts27.16";
const EXTENSIONS: Record<string, string> = {
  ".bash": "bash", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".cs": "c_sharp",
  ".css": "css", ".dart": "dart", ".ex": "elixir", ".exs": "elixir", ".go": "go",
  ".html": "html", ".java": "java", ".js": "javascript", ".mjs":"javascript", ".cjs":"javascript", ".jsx": "javascript", ".json": "json",
  ".kt": "kotlin", ".kts": "kotlin", ".lua": "lua", ".php": "php",
  ".py": "python", ".rb": "ruby", ".rs": "rust", ".scala": "scala",
  ".swift": "swift", ".ts": "typescript", ".tsx": "tsx",
  ".yaml": "yaml", ".yml": "yaml", ".zig": "zig",
};
export function grammarForPath(path: string): string | undefined { return EXTENSIONS[extname(path).toLowerCase()]; }
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".toml"]);
const DEFINITION_TYPES = new Set([
  "function_definition", "function_declaration", "function_item", "function_expression", "generator_function_declaration",
  "method_definition", "method_declaration", "method", "constructor_declaration", "constructor_definition",
  "class_definition", "class_declaration", "interface_declaration", "interface_definition", "trait_item", "trait_declaration",
  "struct_item", "struct_declaration", "struct_specifier", "enum_item", "enum_declaration", "enum_specifier",
  "namespace_definition", "namespace_declaration", "module_declaration", "type_alias_declaration", "type_alias_statement",
]);
function isDefinition(type: string): boolean {
  return DEFINITION_TYPES.has(type) || /^(?:function|method|class|interface|trait|struct|enum|namespace|module|constructor)_(?:definition|declaration|item)$/.test(type);
}
const CALLS = new Set(["call", "call_expression", "invocation_expression", "method_invocation"]);
const PHP_CALLS = new Set(["function_call_expression","member_call_expression","nullsafe_member_call_expression","scoped_call_expression"]);
const PHP_ANONYMOUS = new Set(["anonymous_function_creation_expression","arrow_function"]);
const IMPORTS = /(?:import|include|using|require|use)(?:_from)?_?(?:declaration|statement|directive|expression|header)?$/;

function wasmPath(language: string): string {
  // Resolve a declared runtime dependency from this module, including npm's
  // hoisted layout. Grammar names come only from the fixed extension registry.
  return createRequire(import.meta.url).resolve(`@cursorless/tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
}

function nodeName(node: SyntaxNode): string {
  for (const field of ["name", "declarator", "identifier", "property"]) {
    let candidate = node.childForFieldName(field);
    for (let depth = 0; candidate && depth < 8 && ["function_declarator", "pointer_declarator", "reference_declarator", "parenthesized_declarator", "array_declarator"].includes(candidate.type); depth++) {
      const nested = candidate.childForFieldName("declarator"); if (!nested) break; candidate = nested;
    }
    if (candidate?.text.trim()) return candidate.text.trim().replace(/::/g, ".").replace(/\s+/g, " ").slice(0, 240);
  }
  const identifier = node.namedChildren.filter((child): child is SyntaxNode => child !== null).find((child) => /(?:identifier|name|type_identifier)$/.test(child.type));
  return identifier?.text.trim() ?? `<anonymous@${node.startPosition.row + 1}>`;
}

function signature(node: SyntaxNode): string {
  return node.text.split(/\r?\n/, 1)[0]!.trim().slice(0, 500);
}

function goCallName(target:SyntaxNode,depth=0):string{
  if(depth>=8)return "<dynamic>";
  if(["identifier","field_identifier","package_identifier","type_identifier"].includes(target.type))return /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(target.text)&&target.text.length<=240?target.text:"<dynamic>";
  if(target.type==="parenthesized_expression"){const inner=target.namedChild(0);return inner?goCallName(inner,depth+1):"<dynamic>";}
  if(target.type==="selector_expression"){const operand=target.childForFieldName("operand"),field=target.childForFieldName("field");if(operand&&field)return `${goCallName(operand,depth+1)}.${goCallName(field,depth+1)}`;}
  return "<dynamic>";
}

function goNamedType(node:SyntaxNode|null|undefined):string|undefined{
  if(node?.type==="pointer_type")node=node.namedChild(0);
  return node?.type==="type_identifier"&&/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(node.text)?node.text:undefined;
}

function swiftCallName(target:SyntaxNode,depth=0):string{
  if(depth>=8)return "<dynamic>";
  if(target.type==="simple_identifier")return /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(target.text)&&target.text.length<=240?target.text:"<dynamic>";
  if(target.type==="self_expression")return "self";
  if(target.type==="navigation_expression"){
    const operand=target.childForFieldName("target"),suffix=target.childForFieldName("suffix")?.childForFieldName("suffix");
    if(operand&&suffix)return `${swiftCallName(operand,depth+1)}.${swiftCallName(suffix,depth+1)}`;
  }
  return "<dynamic>";
}

function phpCallName(node:SyntaxNode):string{
  const method=node.childForFieldName("name"),name=method?.type==="name"&&method.text.length<=240?method.text:"<dynamic>";
  if(["member_call_expression","nullsafe_member_call_expression"].includes(node.type)){
    const object=node.childForFieldName("object");return `<receiver>.${object?.type==="variable_name"&&object.text.length<=240?object.text:"<dynamic>"}.${name}`;
  }
  if(node.type==="scoped_call_expression"){
    const scope=node.childForFieldName("scope"),raw=scope&&["name","qualified_name","relative_name","relative_scope"].includes(scope.type)&&scope.text.length<=240?scope.text:"<dynamic>";
    const mode=raw.startsWith("\\")?"static-absolute":/^namespace\\/i.test(raw)?"static-namespace":"static";
    return `<${mode}>.${raw.replace(/^\\|^namespace\\/i,"").replaceAll("\\",".")}.${name}`;
  }
  const target=node.childForFieldName("function");
  if(!target||!["name","qualified_name","relative_name"].includes(target.type)||target.text.length>240)return "<dynamic>";
  const raw=target.text,mode=raw.startsWith("\\")?"function-absolute":/^namespace\\/i.test(raw)?"function-namespace":raw.includes("\\")?"function-relative":"function";
  return `<${mode}>.${raw.replace(/^\\|^namespace\\/i,"").replaceAll("\\",".")}`;
}

function goLiteralType(node:SyntaxNode|null|undefined):string|undefined{
  if(node?.type==="unary_expression"&&node.child(0)?.text==="&")node=node.childForFieldName("operand");
  return node?.type==="composite_literal"?goNamedType(node.childForFieldName("type")):undefined;
}

function callName(node: SyntaxNode,language:string): string | null {
  if(node.type==="method_invocation"){const receiver=node.childForFieldName("object"),name=node.childForFieldName("name");if(receiver&&name)return `${receiver.text}.${name.text}`;}
  const target = node.childForFieldName("function") ?? node.childForFieldName("name") ?? node.namedChild(0);
  if (!target) return null;
  if(language==="go")return goCallName(target);
  if(language==="swift")return swiftCallName(target);
  const value = target.text.trim().replace(/\s+/g, " ");
  const match = value.match(/[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/);
  return match?.[0] ?? null;
}

function kindOf(type: string): string {
  for (const kind of ["class", "interface", "trait", "struct", "enum", "method", "function", "constructor", "module", "namespace", "type"]) {
    if (type.includes(kind)) return kind;
  }
  return "symbol";
}

/** Binding patterns exclude annotation types, property keys and default values. */
function patternNames(node: SyntaxNode | null | undefined): string[] {
  if (!node) return [];
  if (["identifier", "simple_identifier", "shorthand_property_identifier_pattern"].includes(node.type)) return [node.text];
  if(node.type==="pattern")return patternNames(node.childForFieldName("bound_identifier"));
  if(node.type==="directly_assignable_expression")return patternNames(node.namedChild(0));
  if (["parameter_declaration", "variadic_parameter_declaration"].includes(node.type)) return node.namedChildren.filter(child=>child?.type==="identifier").map(child=>child!.text);
  if (["required_parameter", "optional_parameter", "typed_parameter", "default_parameter", "typed_default_parameter", "formal_parameter", "parameter"].includes(node.type)) {
    return patternNames(node.childForFieldName("pattern") ?? node.childForFieldName("name") ?? node.namedChild(0));
  }
  if (["pair_pattern", "assignment_pattern"].includes(node.type)) return patternNames(node.childForFieldName(node.type === "pair_pattern" ? "value" : "left"));
  if (["formal_parameters", "parameters", "parameter_list", "function_value_parameters", "expression_list", "object_pattern", "array_pattern", "pattern_list", "tuple_pattern", "list_pattern", "list_splat_pattern", "dictionary_splat_pattern", "rest_pattern"].includes(node.type)) return node.namedChildren.flatMap(child => patternNames(child));
  return [];
}

function walk(root: SyntaxNode, language: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const lexical = ["typescript", "tsx", "javascript", "python"].includes(language);
  const memberLexical = ["java", "kotlin", "c_sharp", "swift"].includes(language);
  const bind = (scope: string[], pattern: SyntaxNode | null | undefined, source: string) => {
    for (const name of patternNames(pattern)) {
      const implicitReceiver = language === "python" && source === "parameter" && ["self", "cls"].includes(name) && symbols.some(symbol => symbol.kind === "class" && symbol.qualname === scope.slice(0, -1).join("."));
      imports.push({ local: [...scope, name].join("."), imported: "", source: implicitReceiver ? "implicit-receiver" : source, kind: "lexical-binding" });
    }
  };
  const goBind = (scope:string[],pattern:SyntaxNode|null|undefined,type:SyntaxNode|null|undefined,source:string,inferred?:string) => {
    const receiverType=goNamedType(type)??inferred;
    bind(scope,pattern,receiverType?"go-receiver":source);
    if(receiverType)for(const name of patternNames(pattern))imports.push({local:[...scope,name].join("."),imported:receiverType,source:"",kind:"go-receiver-type"});
  };
  const goParameters = (scope:string[],parameters:SyntaxNode|null|undefined) => {
    if(parameters?.type!=="parameter_list")return;
    for(const parameter of parameters.namedChildren)if(parameter)goBind(scope,parameter,parameter.type==="parameter_declaration"?parameter.childForFieldName("type"):undefined,"parameter");
  };
  const visit = (node: SyntaxNode, parents: string[],phpNamespace=""): void => {
    const namespace=language==="php"&&node.type==="namespace_definition"?(node.childForFieldName("name")?.text??"").replaceAll("\\","."):phpNamespace;
    let nextParents = parents;
    const namedCallable=node.type==="variable_declarator"&&["arrow_function","function_expression","generator_function"].includes(node.childForFieldName("value")?.type??"");
    const callableValue=namedCallable?node.childForFieldName("value"):undefined;
    const wrappedCallable=["arrow_function","function_expression","generator_function"].includes(node.type)&&node.parent?.type==="variable_declarator"&&node.parent.childForFieldName("value")?.id===node.id;
    const goType=language==="go"&&["type_spec","type_alias"].includes(node.type);
    const swiftDefinition=language==="swift"&&["protocol_declaration","protocol_function_declaration","typealias_declaration"].includes(node.type);
    const phpAnonymous=language==="php"&&PHP_ANONYMOUS.has(node.type);
    if (isDefinition(node.type)&&!wrappedCallable||namedCallable||goType||swiftDefinition||phpAnonymous) {
      const name = language==="php"&&node.type==="namespace_definition"?namespace||"<global>":phpAnonymous?`<anonymous@${node.startPosition.row+1}:${node.startPosition.column}>`:nodeName(node);
      if (lexical && !namedCallable && parents.length) bind(parents, node.childForFieldName("name"), ["class", "interface"].includes(kindOf(node.type)) ? "class" : "callable");
      const calls: string[] = [];
      const collectCalls = (child: SyntaxNode): void => {
        if (child !== node && child.id!==callableValue?.id && (isDefinition(child.type)||child.type==="arrow_function"||language==="php"&&PHP_ANONYMOUS.has(child.type))) return;
        if (CALLS.has(child.type)||language==="php"&&PHP_CALLS.has(child.type)) { const value = language==="php"?phpCallName(child):callName(child,language); if (value) calls.push(value); }
        for (const nested of child.namedChildren) if (nested) collectCalls(nested);
      };
      collectCalls(node);
      const receiver=node.type==="method_declaration"&&language==="go"?node.childForFieldName("receiver")?.namedChild(0)?.childForFieldName("type"):undefined;
      let base=receiver?.type==="pointer_type"?receiver.namedChild(0):receiver;
      if(base?.type==="generic_type")base=base.childForFieldName("type");
      const receiverName=goNamedType(base);
      const definitionParents=language==="php"&&node.type==="namespace_definition"?[]:language==="php"&&(node.type==="function_definition"||phpAnonymous)?namespace?namespace.split("."):[]:receiverName?[...parents,receiverName]:parents;
      const qualname = [...definitionParents, name].join(".");
      const goTypeKind=goType?node.childForFieldName("type")?.type:undefined;
      const swiftKind=node.type==="protocol_declaration"?"interface":node.type==="protocol_function_declaration"?"method":"type";
      symbols.push({ name, qualname, kind: phpAnonymous?"function":swiftDefinition?swiftKind:goType?(goTypeKind==="struct_type"?"struct":goTypeKind==="interface_type"?"interface":"type"):namedCallable?"function":kindOf(node.type), signature: signature(node),
        startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column, endColumn: node.endPosition.column,
        origin: "tree-sitter", confidence: node.hasError ? "partial" : "high", calls: [...new Set(calls)] });
      nextParents = [...definitionParents, name];
      if(language==="php"){
        if(node.type==="namespace_definition")nextParents=namespace?namespace.split("."):[];
        imports.push({local:qualname,imported:"",source:namespace,kind:"php-namespace"});
        if(["class_declaration","trait_declaration","interface_declaration"].includes(node.type))imports.push({local:qualname,imported:"",source:!node.hasError&&node.type==="class_declaration"?"class":!node.hasError&&node.type==="trait_declaration"?"trait":"unsupported",kind:"php-type-declaration"});
        if(node.type==="method_declaration")imports.push({local:qualname,imported:node.namedChildren.find(child=>child?.type==="visibility_modifier")?.text??"public",source:!node.childForFieldName("body")?"abstract":node.namedChildren.some(child=>child?.type==="static_modifier")?"static":"instance",kind:"php-method"});
      }
      if(goType)imports.push({local:qualname,imported:"",source:node.type==="type_spec"&&!node.childForFieldName("type_parameters")&&goTypeKind==="struct_type"?"struct":"unsupported",kind:"go-type-declaration"});
      if(language==="swift"&&["class_declaration","protocol_declaration","typealias_declaration"].includes(node.type)){
        const bounded=!node.hasError&&!node.namedChildren.some(child=>child&&/type_parameters|type_constraints|generic.*(?:parameter|constraint)/.test(child.type));
        const declaration=node.children.find(child=>child&&/^(?:struct|class|enum|actor|extension)$/.test(child.text))?.text;
        const source=bounded&&declaration&&declaration!=="extension"?"nominal":bounded&&declaration==="extension"?"extension":"unsupported";
        imports.push({local:qualname,imported:"",source,kind:"swift-type-declaration"});
      }
      if (lexical && !["class", "interface", "trait", "namespace", "module"].includes(kindOf(node.type))) bind(nextParents, (callableValue ?? node).childForFieldName("parameters"), "parameter");
      if(memberLexical&&!["class","interface","namespace"].includes(kindOf(node.type)))bind(nextParents,node.childForFieldName("parameters")??node.namedChildren.find(child=>child?.type==="function_value_parameters"),"parameter");
      if(language==="swift")for(const parameter of node.namedChildren)if(parameter?.type==="parameter")bind(nextParents,parameter,"parameter");
      if(language==="go"&&!goType){
        for(const field of ["parameters","receiver","result"])goParameters(nextParents,node.childForFieldName(field));
        for(const parameter of node.childForFieldName("type_parameters")?.namedChildren??[])if(parameter)bind(nextParents,parameter,"type-parameter");
      }
      if(node.parent?.type==="export_statement"&&!/^export\s+type\b/.test(node.parent.text)&&!["interface","type"].includes(kindOf(node.type)))imports.push({local:qualname,imported:/^export\s+default\b/.test(node.parent.text)?"default":name,source:"",kind:"static-export"});
    }
    if (lexical && node.type === "variable_declarator") {
      const value = node.childForFieldName("value"), typed = node.childForFieldName("type");
      bind(parents, node.childForFieldName("name"), namedCallable ? "callable" : value?.type === "new_expression" || typed ? "receiver" : "variable");
    }
    if(memberLexical&&node.type==="variable_declarator")bind(parents,node.childForFieldName("name")??node.namedChildren.find(child=>child?.type==="identifier"),"variable");
    if(language==="kotlin"&&node.type==="variable_declaration")bind(parents,node.namedChildren.find(child=>child?.type==="simple_identifier"),"variable");
    if(language==="swift"&&node.type==="property_declaration")bind(parents,node.childForFieldName("name"),"variable");
    if(language==="swift"&&node.type==="assignment")bind(parents,node.childForFieldName("target"),"variable");
    if(language==="swift"&&node.type==="lambda_parameter")bind(parents,node.childForFieldName("name"),"parameter");
    if(language==="swift"&&node.type==="for_statement")bind(parents,node.childForFieldName("item"),"variable");
    if(language==="php"&&node.type==="namespace_use_declaration")imports.push({local:namespace,imported:"",source:"imports",kind:"php-import-scope"});
    if(language==="php"&&node.type==="use_declaration"){
      const plain=!node.hasError&&node.namedChildren.every(child=>child&&["name","qualified_name","relative_name"].includes(child.type));
      for(const trait of node.namedChildren)if(trait&&["name","qualified_name","relative_name"].includes(trait.type))imports.push({local:parents.join("."),imported:trait.text.length<=240?trait.text:"<dynamic>",source:plain?"plain":"adapted",kind:"php-trait-use"});
    }
    if(language==="go"){
      if(node.type==="short_var_declaration"){
        const left=node.childForFieldName("left"),right=node.childForFieldName("right");
        if(left?.namedChildCount===1&&right?.namedChildCount===1)goBind(parents,left,undefined,"variable",goLiteralType(right.namedChild(0)));
        else bind(parents,left,"variable");
      }
      if(["range_clause","assignment_statement"].includes(node.type))bind(parents,node.childForFieldName("left"),"variable");
      if(["var_spec","const_spec"].includes(node.type))for(const child of node.namedChildren)if(child?.type==="identifier")goBind(parents,child,node.type==="var_spec"?node.childForFieldName("type"):undefined,"variable");
      if(node.type==="func_literal")bind(parents,node.childForFieldName("parameters"),"parameter");
    }
    if (lexical && ["for_in_statement", "for_statement"].includes(node.type)) bind(parents, node.childForFieldName("left"), "variable");
    if (lexical && node.type === "catch_clause") bind(parents, node.childForFieldName("parameter"), "variable");
    if (language === "python" && ["assignment", "augmented_assignment", "named_expression", "for_in_clause"].includes(node.type)) bind(parents, node.childForFieldName("left") ?? node.childForFieldName("name"), "variable");
    if (IMPORTS.test(node.type)) {
      const source = (node.childForFieldName("source") ?? node.childForFieldName("path"))?.text.replace(/["']/g, "") ?? node.text;
      imports.push({ local: "", imported: "", source: source.trim().slice(0, 500), kind: node.type });
      if(language!=="go"&&!["typescript","tsx","javascript"].includes(language))imports.push(...staticImports(node.text, language).map(item=>language==="python"?{...item,local:[...parents,item.local].join(".")}:item));
    }
    if(["typescript","tsx","javascript"].includes(language)){
      if(node.type==="import_statement"){
        const source=node.childForFieldName("source")?.text.slice(1,-1),clause=node.namedChildren.find(child=>child?.type==="import_clause");
        if(source&&clause)for(const child of clause.namedChildren){
          if(!child)continue;
          const kind=/^import\s+type\b/.test(node.text)?"type-import":"static-import";
          if(child.type==="identifier")imports.push({local:child.text,imported:"default",source,kind});
          if(child.type==="namespace_import")imports.push({local:child.namedChild(0)!.text,imported:"*",source,kind});
          if(child.type==="named_imports")for(const spec of child.namedChildren)if(spec){const name=spec.childForFieldName("name"),alias=spec.childForFieldName("alias");if(name)imports.push({local:alias?.text??name.text,imported:name.text,source,kind:/^type\s/.test(spec.text)?"type-import":kind});}
        }
      }
      if(node.type==="export_statement"&&!/^export\s+type\b/.test(node.text)){
        const source=node.childForFieldName("source")?.text.slice(1,-1),clause=node.namedChildren.find(child=>child?.type==="export_clause"),value=node.childForFieldName("value");
        if(clause){for(const spec of clause.namedChildren)if(spec&&!/^type\s/.test(spec.text)){const name=spec.childForFieldName("name"),alias=spec.childForFieldName("alias");if(name)imports.push(source?{local:alias?.text??name.text,imported:name.text,source,kind:"static-reexport"}:{local:name.text,imported:alias?.text??name.text,source:"",kind:"static-export"});}}
        else if(source&&node.children.some(child=>child?.type==="*"))imports.push({local:"*",imported:"*",source,kind:"static-reexport"});
        if(value?.type==="identifier"&&/^export\s+default\b/.test(node.text))imports.push({local:value.text,imported:"default",source:"",kind:"static-export"});
      }
      if(node.type==="variable_declarator"&&node.parent?.parent?.type==="export_statement")for(const name of patternNames(node.childForFieldName("name")))imports.push({local:[...parents,name].join("."),imported:name,source:"",kind:"static-export"});
    }
    if(["typescript","tsx","javascript"].includes(language)&&node.type==="variable_declarator"){
      const name=node.childForFieldName("name"),value=node.childForFieldName("value"),type=node.childForFieldName("type");
      const constructor=value?.type==="new_expression"?value.childForFieldName("constructor"):undefined;
      const receiverType=constructor?.text??type?.text.replace(/^:\s*/,"").trim();
      if(name&&receiverType&&/^[A-Za-z_$][\w$]*$/.test(name.text)&&/^[A-Za-z_$][\w$]*$/.test(receiverType))imports.push({local:[...parents,name.text].join("."),imported:receiverType,source:"",kind:"receiver-type"});
    }
    if(language==="go"&&node.type==="import_spec"){const literal=node.childForFieldName("path");if(literal){const source=literal.text.slice(1,-1);imports.push({local:node.childForFieldName("name")?.text??"",imported:"*",source,kind:"static-import"});}}
    if(language==="go"&&node.type==="package_clause")imports.push({local:"",imported:"",source:node.text.replace(/^package\s+/,"").trim(),kind:"package"});
    let followingNamespace=namespace;
    for (const child of node.namedChildren) if (child){
      if(language==="php"&&node.type==="program"){
        if(child.type==="namespace_definition"&&!child.childForFieldName("body"))followingNamespace=(child.childForFieldName("name")?.text??"").replaceAll("\\",".");
        visit(child,child.type==="namespace_definition"?[]:followingNamespace?followingNamespace.split("."):[],followingNamespace);
      }else visit(child,nextParents,namespace);
    }
  };
  visit(root, []);
  return { symbols, imports: imports.filter(item=>{
    if(item.kind!=="static-export")return true;
    const declarations=symbols.filter(symbol=>symbol.qualname===item.local);
    return !declarations.length||declarations.some(symbol=>!["interface","type"].includes(symbol.kind));
  }) };
}

function staticImports(content: string, language: string): ParsedImport[] {
  const found: ParsedImport[] = [];
  if (["typescript", "tsx", "javascript"].includes(language)) {
    for(const match of content.matchAll(/\bexport\s+(?:\{([^}]+)\}|(\*))\s+from\s*["']([^"']+)["']/g)){
      if(match[2])found.push({local:"*",imported:"*",source:match[3]!,kind:"static-reexport"});
      for(const item of match[1]?.split(",")??[]){const names=/^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item);if(names)found.push({local:names[2]??names[1]!,imported:names[1]!,source:match[3]!,kind:"static-reexport"});}
    }
    const declaration = /\bimport\s+(?!\()(?:([\w$]+)\s*,?\s*)?(?:\{([^}]+)\}|\*\s+as\s+([\w$]+))?\s*from\s*["']([^"']+)["']/g;
    for (const match of content.matchAll(declaration)) {
      const source = match[4]!;
      if (match[1]) found.push({local:match[1],imported:"default",source,kind:"static-import"});
      if (match[3]) found.push({local:match[3],imported:"*",source,kind:"static-import"});
      for (const item of match[2]?.split(",")??[]) {
        const names = /\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*/.exec(item);
        if (names) found.push({local:names[2]??names[1]!,imported:names[1]!,source,kind:"static-import"});
      }
    }
  }
  if (language === "python") {
    for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/gm)) {
      for (const item of match[2]!.split(",")) {
        const names = /\s*([\w]+)(?:\s+as\s+([\w]+))?\s*/.exec(item);
        if (names) found.push({local:names[2]??names[1]!,imported:names[1]!,source:match[1]!,kind:"static-import"});
      }
    }
    for(const match of content.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm))found.push({local:match[2]??match[1]!.split(".")[0]!,imported:"*",source:match[1]!,kind:"static-import"});
  }
  if(["java","kotlin"].includes(language))for(const match of content.matchAll(/\bimport\s+(?:static\s+)?([\w.]+)(?:\s+as\s+(\w+))?/g)){const parts=match[1]!.split(".");found.push({local:match[2]??parts.at(-1)!,imported:parts.at(-1)!,source:parts.slice(0,-1).join("."),kind:"static-import"});}
  return found;
}

function chunks(content: string, symbols: ParsedSymbol[]): ParsedChunk[] {
  const symbolChunks = symbols.map((symbol) => ({ symbol: symbol.qualname, heading: null,
    startLine: symbol.startLine, endLine: symbol.endLine, startColumn: symbol.startColumn, endColumn: symbol.endColumn,
    body: content.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine).join("\n") }));
  const lines = content.split(/\r?\n/);
  const result: ParsedChunk[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const end = Math.min(lines.length, start + 100);
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) result.push({ symbol: null, heading: lines.slice(start, end).find((line) => /^#{1,6}\s/.test(line))?.replace(/^#+\s*/, "") ?? null,
      startLine: start + 1, endLine: end, startColumn: 0, endColumn: lines[end - 1]?.length ?? 0, body });
  }
  return [...symbolChunks, ...result];
}

function knowledgeMetadata(path:string,content:string):{knowledgeType?:string;knowledgeLinks?:string[];knowledgeMetadata?:Record<string,unknown>}{
  if(extname(path).toLowerCase()!==".md"||/(?:^|\/)(?:generated|vendor|runbooks|scratch|temp|temporary)(?:\/|$)/i.test(path)||/(?:^|\/)(?:index|log)\.md$/i.test(path))return{};
  const lines=content.split(/\r?\n/),end=lines.findIndex((line,index)=>index>0&&line.trim()==="---");if(lines[0]?.trim()!=="---"||end<0)return{};
  let metadata:unknown;try{metadata=YAML.parse(lines.slice(1,end).join("\n"));}catch{return{};}
  const type=(metadata as {type?:unknown}|null)?.type;if(typeof type!=="string"||!type.trim()||type.trim().toLowerCase()==="log"||/(?:runbook|handoff|session|temporary|scratch)/i.test(type))return{};
  const links=new Set<string>();
  for(const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
    const raw=match[1]!.trim().split(/\s+/,1)[0]!.replace(/^<|>$/g,"").split(/[?#]/,1)[0]!;
    if(!raw||/^[a-z]+:/i.test(raw)||raw.startsWith("//"))continue;
    let target:string;try{target=posix.normalize(posix.join(posix.dirname(path),decodeURIComponent(raw)));}catch{continue;}
    if(target!==path&&!target.startsWith("../")&&!target.startsWith("/"))links.add(target);
  }
  return{knowledgeType:type.trim(),knowledgeLinks:[...links].sort(),knowledgeMetadata:metadata as Record<string,unknown>};
}

export class SourceParser {
  private readonly parser = new Parser();
  private readonly languages = new Map<string, Language>();
  private static initialized: Promise<void> | undefined;

  static async create(): Promise<SourceParser> {
    SourceParser.initialized ??= Parser.init();
    await SourceParser.initialized;
    return new SourceParser();
  }

  supports(path: string): boolean { const extension = extname(path).toLowerCase(); return extension in EXTENSIONS || TEXT_EXTENSIONS.has(extension); }

  close():void { this.parser.delete(); }

  private async language(name: string): Promise<Language> {
    const cached = this.languages.get(name);
    if (cached) return cached;
    const path = wasmPath(name);
    await access(path);
      const loaded = await Language.load(path);
    this.languages.set(name, loaded);
    return loaded;
  }

  async parse(path: string, content: string): Promise<ParsedFile> {
    const extension = extname(path).toLowerCase();
    const languageName = grammarForPath(path);
    if (!languageName) return { path, contentHash: sha256(content), language: TEXT_EXTENSIONS.has(extension) ? "text" : "unknown",
      parserId: "text", grammarVersion: "none", extractorVersion: EXTRACTOR_VERSION, symbols: [], imports: [], edges: [], chunks: chunks(content, []), diagnostics: [],
      status: TEXT_EXTENSIONS.has(extension) ? "parsed" : "unsupported",...knowledgeMetadata(path,content) };
    try {
      const language = await this.language(languageName);
      this.parser.setLanguage(language);
      this.parser.reset();
      const tree = this.parser.parse(content);
      if (!tree) throw new Error("Tree-sitter returned no syntax tree");
      const extracted = walk(tree.rootNode, languageName);
      const edges=extracted.symbols.flatMap(symbol=>symbol.calls.map(target=>({source:symbol.qualname,target,kind:"call",confidence:"unresolved"})));
      const result: ParsedFile = { path, contentHash: sha256(content), language: languageName, parserId: "web-tree-sitter",
        grammarVersion: String(language.abiVersion), extractorVersion: EXTRACTOR_VERSION, ...extracted,
        edges,
        chunks: chunks(content, extracted.symbols), diagnostics: tree.rootNode.hasError ? ["syntax tree contains errors"] : [],
        status: tree.rootNode.hasError ? "partial" : "parsed" };
      tree.delete();
      return result;
    } catch (error) {
      return { path, contentHash: sha256(content), language: languageName, parserId: "web-tree-sitter", grammarVersion: "unknown",
        extractorVersion: EXTRACTOR_VERSION, symbols: [], imports: [], edges: [], chunks: chunks(content, []), diagnostics: [error instanceof Error?`${error.name}: ${error.message}`:String(error)], status: "failed" };
    }
  }
}
