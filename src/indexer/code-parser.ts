import { readFileSync } from "node:fs";
import { extname } from "node:path";

import Parser, { type Language, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";
import DartParser, { type SyntaxNode as DartSyntaxNode } from "@sengac/tree-sitter";
import Dart from "@sengac/tree-sitter-dart";
import { Parser as WasmParser, type Node as WasmNode } from "web-tree-sitter";

import {
  DynamicGrammarLoader,
  type DynamicGrammarName
} from "./dynamic-grammar.js";

export type CodeLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "dart"
  | "go"
  | "rust"
  | "java";

export type CodeSymbol = {
  name: string;
  type: "function" | "class" | "method" | "arrow_function";
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: CodeLanguage;
  bodyText: string;
  signatureText: string;
};

type SymbolType = CodeSymbol["type"];

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py"]);
const DART_EXTENSIONS = new Set([".dart"]);
const DYNAMIC_EXTENSIONS = new Map<string, DynamicGrammarName>([
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"]
]);
const { tsx, typescript } = TypeScriptGrammars;

export class CodeParser {
  constructor(private readonly dynamicGrammars: DynamicGrammarLoader = new DynamicGrammarLoader()) {}

  parseFile(filePath: string): CodeSymbol[] {
    const language = detectLanguage(filePath);
    if (!language) {
      return [];
    }

    try {
      const source = readFileSync(filePath, "utf8");
      if (language === "dart") {
        return parseDartSymbols(source, filePath);
      }

      const parser = new Parser();
      parser.setLanguage(loadLanguage(filePath, language));

      const tree = parser.parse(source);
      if (tree.rootNode.hasError) {
        return [];
      }

      return extractSymbols(tree.rootNode, source, filePath, language);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Warning: failed to parse ${filePath}: ${message}`);
      return [];
    }
  }

  async parseFileAsync(filePath: string): Promise<CodeSymbol[]> {
    const language = detectLanguage(filePath);
    if (!language || !isDynamicLanguage(language)) {
      return this.parseFile(filePath);
    }

    try {
      const source = readFileSync(filePath, "utf8");
      const grammar = await this.dynamicGrammars.load(language);
      const parser = new WasmParser();
      parser.setLanguage(grammar);
      const tree = parser.parse(source);
      if (!tree || tree.rootNode.hasError) {
        return [];
      }
      return extractDynamicSymbols(tree.rootNode, source, filePath, language);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Warning: failed to parse ${filePath}: ${message}`);
      return [];
    }
  }
}

function detectLanguage(filePath: string): CodeLanguage | null {
  const extension = extname(filePath).toLowerCase();

  if (JS_EXTENSIONS.has(extension)) {
    return "javascript";
  }

  if (TS_EXTENSIONS.has(extension)) {
    return "typescript";
  }

  if (PY_EXTENSIONS.has(extension)) {
    return "python";
  }

  if (DART_EXTENSIONS.has(extension)) {
    return "dart";
  }

  const dynamicLanguage = DYNAMIC_EXTENSIONS.get(extension);
  if (dynamicLanguage) {
    return dynamicLanguage;
  }

  return null;
}

function loadLanguage(filePath: string, language: CodeLanguage): Language {
  if (language === "javascript") {
    return JavaScript;
  }

  if (language === "python") {
    return Python;
  }

  if (language === "dart" || isDynamicLanguage(language)) {
    throw new Error(`${language} uses the modern Tree-sitter runtime`);
  }

  return extname(filePath).toLowerCase() === ".tsx" ? tsx : typescript;
}

function isDynamicLanguage(language: CodeLanguage): language is DynamicGrammarName {
  return language === "go" || language === "rust" || language === "java";
}

function extractDynamicSymbols(
  rootNode: WasmNode,
  source: string,
  filePath: string,
  language: DynamicGrammarName
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function visit(node: WasmNode): void {
    const type = dynamicSymbolType(node, language);
    if (type) {
      const nameNode = node.childForFieldName("name") ??
        node.namedChildren.find(
          (child): child is WasmNode => child !== null && isDynamicNameNode(child)
        );
      if (nameNode) {
        symbols.push(createDynamicSymbol(node, nameNode.text, type, source, filePath, language));
      }
    }

    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  }

  visit(rootNode);
  return symbols;
}

function dynamicSymbolType(
  node: WasmNode,
  language: DynamicGrammarName
): SymbolType | null {
  if (language === "go") {
    if (node.type === "function_declaration") return "function";
    if (node.type === "method_declaration") return "method";
    if (node.type === "type_spec") return "class";
  }

  if (language === "rust") {
    if (node.type === "function_item") {
      return hasDynamicAncestor(node, "impl_item") ? "method" : "function";
    }
    if (["struct_item", "enum_item", "trait_item"].includes(node.type)) return "class";
  }

  if (language === "java") {
    if (["method_declaration", "constructor_declaration"].includes(node.type)) return "method";
    if (
      ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"].includes(
        node.type
      )
    ) return "class";
  }

  return null;
}

function createDynamicSymbol(
  node: WasmNode,
  name: string,
  type: SymbolType,
  source: string,
  filePath: string,
  language: DynamicGrammarName
): CodeSymbol {
  const bodyNode = node.childForFieldName("body") ?? node.namedChildren.find(
    (child): child is WasmNode =>
      child !== null && ["block", "class_body", "declaration_list"].includes(child.type)
  );
  const signatureEnd = bodyNode?.startIndex ?? node.endIndex;

  return {
    name,
    type,
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    language,
    bodyText: source.slice(node.startIndex, node.endIndex),
    signatureText: compactSignature(source.slice(node.startIndex, signatureEnd))
  };
}

function hasDynamicAncestor(node: WasmNode, type: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === type) return true;
    current = current.parent;
  }
  return false;
}

function isDynamicNameNode(node: WasmNode): boolean {
  return ["identifier", "type_identifier"].includes(node.type);
}

function extractSymbols(
  rootNode: SyntaxNode,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function visit(node: SyntaxNode): void {
    const symbol = symbolFromNode(node, source, filePath, language);
    if (symbol) {
      symbols.push(symbol);
    }

    if (node.type === "decorated_definition") {
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);

  return symbols;
}

function symbolFromNode(
  node: SyntaxNode,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol | null {
  if (language === "python") {
    return pythonSymbolFromNode(node, source, filePath, language);
  }

  return jsTsSymbolFromNode(node, source, filePath, language);
}

function jsTsSymbolFromNode(
  node: SyntaxNode,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol | null {
  if (node.type === "function_declaration") {
    return createSymbol(node, readName(node), "function", source, filePath, language);
  }

  if (node.type === "class_declaration") {
    return createSymbol(node, readName(node), "class", source, filePath, language);
  }

  if (node.type === "method_definition") {
    return createSymbol(node, readName(node), "method", source, filePath, language);
  }

  if (node.type === "arrow_function") {
    return createSymbol(
      node,
      readAssignedArrowName(node),
      "arrow_function",
      source,
      filePath,
      language
    );
  }

  return null;
}

function pythonSymbolFromNode(
  node: SyntaxNode,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol | null {
  if (node.type === "class_definition") {
    return createSymbol(node, readName(node), "class", source, filePath, language);
  }

  if (node.type === "function_definition") {
    return createSymbol(
      node,
      readName(node),
      isInsideClass(node) ? "method" : "function",
      source,
      filePath,
      language
    );
  }

  if (node.type === "decorated_definition") {
    return decoratedPythonSymbolFromNode(node, source, filePath, language);
  }

  return null;
}

function decoratedPythonSymbolFromNode(
  node: SyntaxNode,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol | null {
  const innerDefinition = node.namedChildren.find(
    (child) => child.type === "function_definition" || child.type === "class_definition"
  );

  if (!innerDefinition) {
    return null;
  }

  const symbolType: SymbolType =
    innerDefinition.type === "class_definition"
      ? "class"
      : isInsideClass(node)
        ? "method"
        : "function";

  return createSymbol(
    node,
    readName(innerDefinition),
    symbolType,
    source,
    filePath,
    language
  );
}

function createSymbol(
  node: SyntaxNode,
  name: string | null,
  type: SymbolType,
  source: string,
  filePath: string,
  language: CodeLanguage
): CodeSymbol | null {
  if (!name) {
    return null;
  }

  return {
    name,
    type,
    filePath,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    language,
    bodyText: source.slice(node.startIndex, node.endIndex),
    signatureText: readSignatureText(node, source)
  };
}

function readSignatureText(node: SyntaxNode, source: string): string {
  const bodyNode =
    node.childForFieldName("body") ??
    node.namedChildren.find((child) => child.type === "statement_block" || child.type === "block");
  const endIndex = bodyNode?.startIndex ?? node.endIndex;
  return compactSignature(source.slice(node.startIndex, endIndex));
}

function parseDartSymbols(source: string, filePath: string): CodeSymbol[] {
  const parser = new DartParser();
  parser.setLanguage(Dart);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    return [];
  }

  const symbols: CodeSymbol[] = [];

  function visit(node: DartSyntaxNode): void {
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push(createDartSymbol(node, nameNode.text, "class", source, filePath));
      }
    } else if (node.type === "method_signature") {
      const name = readDartCallableName(node);
      if (name) {
        symbols.push(
          createDartSymbol(
            extendThroughDartBody(node),
            name,
            "method",
            source,
            filePath,
            node
          )
        );
      }
    } else if (
      (node.type === "constructor_signature" ||
        node.type === "constant_constructor_signature") &&
      node.parent?.type !== "method_signature"
    ) {
      const name = readDartCallableName(node);
      if (name) {
        symbols.push(createDartSymbol(node, name, "method", source, filePath));
      }
    } else if (
      node.type === "function_signature" &&
      node.parent?.type !== "method_signature"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push(
          createDartSymbol(
            extendThroughDartBody(node),
            nameNode.text,
            isInsideDartClass(node) ? "method" : "function",
            source,
            filePath,
            node
          )
        );
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return symbols;
}

function createDartSymbol(
  bodyNode: DartSyntaxNode,
  name: string,
  type: SymbolType,
  source: string,
  filePath: string,
  signatureNode: DartSyntaxNode = bodyNode
): CodeSymbol {
  const dartClassBody = signatureNode.namedChildren.find(
    (child) => child.type === "class_body"
  );
  const signatureEnd = dartClassBody?.startIndex ?? signatureNode.endIndex;

  return {
    name,
    type,
    filePath,
    lineStart: signatureNode.startPosition.row + 1,
    lineEnd: bodyNode.endPosition.row + 1,
    language: "dart",
    bodyText: source.slice(signatureNode.startIndex, bodyNode.endIndex),
    signatureText: compactSignature(
      source.slice(signatureNode.startIndex, signatureEnd)
    )
  };
}

function extendThroughDartBody(node: DartSyntaxNode): DartSyntaxNode {
  const sibling = node.nextNamedSibling;
  return sibling?.type === "function_body" ? sibling : node;
}

function readDartCallableName(node: DartSyntaxNode): string | null {
  const queue = [...node.namedChildren];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const nameNode = current.childForFieldName("name");
    if (nameNode) {
      return nameNode.text;
    }
    if (current.type === "identifier") {
      return current.text;
    }
    queue.push(...current.namedChildren);
  }

  return null;
}

function isInsideDartClass(node: DartSyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "class_definition") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function compactSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\s*\{$/, "");
}

function readName(node: SyntaxNode): string | null {
  const namedNode = node.childForFieldName("name") ?? node.namedChildren.find(isNameNode);

  return namedNode ? readNodeText(namedNode) : null;
}

function readAssignedArrowName(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (parent?.type !== "variable_declarator") {
    return null;
  }

  const nameNode = parent.childForFieldName("name") ?? parent.namedChildren.find(isNameNode);

  return nameNode ? readNodeText(nameNode) : null;
}

function readNodeText(node: SyntaxNode): string {
  return node.text;
}

function isNameNode(node: SyntaxNode): boolean {
  return (
    node.type === "identifier" ||
    node.type === "type_identifier" ||
    node.type === "property_identifier"
  );
}

function isInsideClass(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "class_definition" || current.type === "class_declaration") {
      return true;
    }

    current = current.parent;
  }

  return false;
}
