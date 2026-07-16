declare module "tree-sitter" {
  export type Point = {
    row: number;
    column: number;
  };

  export type Language = object;

  export class SyntaxNode {
    readonly type: string;
    readonly startPosition: Point;
    readonly endPosition: Point;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly text: string;
    readonly namedChildren: SyntaxNode[];
    readonly parent: SyntaxNode | null;
    readonly hasError: boolean;
    childForFieldName(fieldName: string): SyntaxNode | null;
  }

  export class Tree {
    readonly rootNode: SyntaxNode;
  }

  export default class Parser {
    setLanguage(language: Language): void;
    parse(input: string): Tree;
  }
}

declare module "tree-sitter-javascript" {
  import type { Language } from "tree-sitter";

  const language: Language;
  export default language;
}

declare module "tree-sitter-python" {
  import type { Language } from "tree-sitter";

  const language: Language;
  export default language;
}

declare module "tree-sitter-typescript" {
  import type { Language } from "tree-sitter";

  const grammars: {
    typescript: Language;
    tsx: Language;
  };

  export default grammars;
}
