export type TttCell = "X" | "O" | null;

const tttLines = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export function tttWinner(board: ReadonlyArray<TttCell>): 0 | 1 | 2 {
  for (const [a, b, c] of tttLines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a] === "X" ? 1 : 2;
    }
  }
  return 0;
}

export function tttDraw(board: ReadonlyArray<TttCell>): boolean {
  return board.every(Boolean) && tttWinner(board) === 0;
}

export function c4Winner(board: ReadonlyArray<ReadonlyArray<number>>): 0 | 1 | 2 {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const value = board[row]?.[column];
      if (value !== 1 && value !== 2) continue;
      for (const [dr, dc] of directions) {
        if ([1, 2, 3].every((step) => board[row + dr * step]?.[column + dc * step] === value)) {
          return value;
        }
      }
    }
  }
  return 0;
}

export function c4Draw(board: ReadonlyArray<ReadonlyArray<number>>): boolean {
  return board[0]?.every((cell) => cell !== 0) === true && c4Winner(board) === 0;
}
