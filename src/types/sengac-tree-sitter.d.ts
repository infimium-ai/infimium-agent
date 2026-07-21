declare module "@sengac/tree-sitter" {
  export type Point = {
    row: number;
    column: number;
  };

  export class SyntaxNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: Point;
    endPosition: Point;
    hasError: boolean;
    parent: SyntaxNode | null;
    nextNamedSibling: SyntaxNode | null;
    namedChildren: SyntaxNode[];
    childForFieldName(name: string): SyntaxNode | null;
  }

  export type Tree = {
    rootNode: SyntaxNode;
  };

  export type Language = {
    name: string;
    language?: unknown;
  };

  export default class Parser {
    setLanguage(language: Language): void;
    parse(source: string): Tree;
  }
}
