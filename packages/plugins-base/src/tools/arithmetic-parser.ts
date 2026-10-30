export class ArithmeticParser {
  #position = 0;
  constructor(private readonly source: string) {}
  parse(): number {
    const value = this.expression(); this.space();
    if (this.#position !== this.source.length) throw new Error(`Unexpected token at position ${this.#position + 1}`);
    if (!Number.isFinite(value)) throw new Error("Expression produced a non-finite value");
    return value;
  }
  private expression(): number {
    let value = this.term();
    while (true) { this.space(); if (this.take("+")) value += this.term(); else if (this.take("-")) value -= this.term(); else return value; }
  }
  private term(): number {
    let value = this.power();
    while (true) { this.space(); if (this.take("*")) value *= this.power(); else if (this.take("/")) value /= this.power(); else if (this.take("%")) value %= this.power(); else return value; }
  }
  private power(): number { const value = this.unary(); this.space(); return this.take("^") ? value ** this.power() : value; }
  private unary(): number { this.space(); if (this.take("+")) return this.unary(); if (this.take("-")) return -this.unary(); return this.primary(); }
  private primary(): number {
    this.space();
    if (this.take("(")) { const value = this.expression(); this.space(); if (!this.take(")")) throw new Error("Missing closing parenthesis"); return value; }
    const match = this.source.slice(this.#position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (!match) throw new Error(`Expected a number at position ${this.#position + 1}`);
    this.#position += match[0].length; return Number(match[0]);
  }
  private take(token: string): boolean { if (!this.source.startsWith(token, this.#position)) return false; this.#position += token.length; return true; }
  private space(): void { while (/\s/.test(this.source[this.#position] ?? "")) this.#position += 1; }
}
