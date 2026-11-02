export interface DiffOp { type: 'equal' | 'insert' | 'delete'; text: string; }

function splitLinesPreservingEndings(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*(?:\n|$)/g)?.filter(line => line.length > 0) ?? [];
}

/** Line diff that keeps line endings, so each side stays renderable Markdown. */
export function computeMarkdownDiff(oldText: string, newText: string): DiffOp[] {
  const allOldLines = splitLinesPreservingEndings(oldText);
  const allNewLines = splitLinesPreservingEndings(newText);
  // The unchanged note can dwarf a small edit. Only the changed middle needs
  // the quadratic matrix; keep the original line endings around it verbatim.
  let oldEnd = allOldLines.length, newEnd = allNewLines.length;
  while (oldEnd > 0 && newEnd > 0 && allOldLines[oldEnd - 1] === allNewLines[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  let prefixLength = 0;
  while (prefixLength < oldEnd && prefixLength < newEnd
    && allOldLines[prefixLength] === allNewLines[prefixLength]) prefixLength++;
  const oldLines = allOldLines.slice(prefixLength, oldEnd);
  const newLines = allNewLines.slice(prefixLength, newEnd);
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i-1] === newLines[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const temp: DiffOp[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
      temp.push({ type: 'equal', text: oldLines[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      temp.push({ type: 'insert', text: newLines[j-1] });
      j--;
    } else {
      temp.push({ type: 'delete', text: oldLines[i-1] });
      i--;
    }
  }

  const operations = temp.reverse();
  if (prefixLength > 0) operations.unshift({ type: 'equal', text: allOldLines.slice(0, prefixLength).join('') });
  if (oldEnd < allOldLines.length) operations.push({ type: 'equal', text: allOldLines.slice(oldEnd).join('') });
  return mergeAdjacentDiffOps(operations);
}

function mergeAdjacentDiffOps(ops: DiffOp[]): DiffOp[] {
  const merged: DiffOp[] = [];
  for (const op of ops) {
    if (merged.length > 0 && merged[merged.length-1].type === op.type) {
      merged[merged.length-1].text += op.text;
    } else {
      merged.push({ ...op });
    }
  }
  return merged;
}

export function buildMarkdownDiffDocuments(diffOps: DiffOp[]): Array<{ type: DiffOp['type']; markdown: string }> {
  const oldMarkdown = diffOps
    .filter(op => op.type !== 'insert')
    .map(op => op.text)
    .join('');
  const newMarkdown = diffOps
    .filter(op => op.type !== 'delete')
    .map(op => op.text)
    .join('');
  const hasDeletion = diffOps.some(op => op.type === 'delete');
  const hasInsertion = diffOps.some(op => op.type === 'insert');

  const documents: Array<{ type: DiffOp['type']; markdown: string }> = [];

  if (hasDeletion && oldMarkdown) {
    documents.push({ type: 'delete', markdown: oldMarkdown });
  }

  if (hasInsertion && newMarkdown) {
    documents.push({ type: 'insert', markdown: newMarkdown });
  }

  if (documents.length === 0 && newMarkdown) {
    documents.push({ type: 'equal', markdown: newMarkdown });
  }

  return documents;
}

export function diffOpsEqual(left: DiffOp[], right: DiffOp[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((op, index) => {
    const other = right[index];
    return op.type === other.type && op.text === other.text;
  });
}

export function countDiffLines(diffOps: DiffOp[], type: DiffOp['type']): number {
  return diffOps
    .filter(op => op.type === type)
    .reduce((count, op) => count + splitLinesPreservingEndings(op.text).length, 0);
}
