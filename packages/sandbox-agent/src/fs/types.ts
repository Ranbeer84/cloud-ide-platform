export type FsEntryKind = "file" | "directory";

export interface FsEntryRef {
  readonly path: string;
  readonly kind: FsEntryKind;
}

export interface FsTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: FsEntryKind;
  readonly children?: readonly FsTreeNode[];
}

export type FsChangeEvent =
  | { readonly type: "create"; readonly entry: FsEntryRef }
  | { readonly type: "update"; readonly entry: FsEntryRef }
  | { readonly type: "delete"; readonly entry: FsEntryRef }
  | { readonly type: "rename"; readonly from: FsEntryRef; readonly to: FsEntryRef };
