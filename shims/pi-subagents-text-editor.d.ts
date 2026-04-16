export interface TextEditorState {
  buffer: string;
  cursor: number;
  viewportOffset: number;
}

export function createEditorState(initial?: string): TextEditorState;
export function wrapText(text: string, width: number): { lines: string[]; starts: number[] };
export function getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number };
export function ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number;
export function handleEditorInput(
  state: TextEditorState,
  data: string,
  textWidth: number,
  options?: { multiLine?: boolean },
): TextEditorState | null;
export function renderEditor(state: TextEditorState, width: number, viewportHeight: number): string[];
