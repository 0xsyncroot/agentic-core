/**
 * The handful of TeX symbols a model writes into prose, as the characters they mean.
 *
 * A model writes a menu path as "Payroll $\rightarrow$ Sheets": the renderer is Markdown, there is
 * no maths here, and unmapped the reader sees dollar signs and a backslash in the middle of it.
 * Symbol macros in prose are mapped here; a math span is read as text by `plainMath`.
 */
const TEX_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\$\\(?:rightarrow|to)\$|\\(?:rightarrow|to)\b/g, "→"],
  [/\$\\leftarrow\$|\\leftarrow\b/g, "←"],
  [/\$\\Rightarrow\$|\\Rightarrow\b/g, "⇒"],
  [/\$\\leftrightarrow\$|\\leftrightarrow\b/g, "↔"],
  [/\$\\times\$|\\times\b/g, "×"],
];

/** TeX commands a model writes inside math, as the plain characters they stand for. */
const TEX_COMMANDS: Readonly<Record<string, string>> = {
  approx: "≈", times: "×", cdot: "·", div: "÷", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔", leftrightarrow: "↔",
  dots: "…", ldots: "…", cdots: "…", sum: "Σ", Delta: "Δ", infty: "∞", quad: " ", qquad: " ",
};

/**
 * A math span as the text it reads as. The widget has no TeX renderer, and a model writes sums the way chat apps render them:
 * a report's close-the-sum line comes as "$\text{Total gap} \approx \text{Missing insurance} + …$".
 */
function texText(tex: string): string {
  let text = tex;
  for (let pass = 0; pass < 4; pass += 1) {
    text = text.replace(/\\(?:mathbf|textbf|boldsymbol)\s*\{([^{}]*)\}/g, "**$1**")
      .replace(/\\(?:text|mathrm|textrm|operatorname|mathit|textit)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
  }
  return text.replace(/\\([A-Za-z]+)/g, (_, name: string) => TEX_COMMANDS[name] ?? name)
    .replace(/\\[,;:! ]/g, " ").replace(/\\([{}%_&#$])/g, "$1").replace(/[{}]/g, "").replace(/[ \t]+/g, " ").trim();
}

/** `$…$` holding a TeX command, `$$…$$`, `\(…\)` and `\[…\]` become text; a `$` amount with no command stays as written. */
function plainMath(markdown: string): string {
  return markdown.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g,
    (whole, block?: string, square?: string, round?: string, inline?: string) => {
      if (inline !== undefined && !inline.includes("\\")) return whole;
      return texText(block ?? square ?? round ?? inline ?? "");
    });
}

/** Outside code: fenced blocks and `inline code` keep what the model wrote. */
function plainSymbols(markdown: string): string {
  const prose = (text: string) => TEX_SYMBOLS.reduce((current, [pattern, symbol]) => current.replace(pattern, symbol), plainMath(text));
  return markdown.split(/(^\s*```[\s\S]*?^\s*```\s*$)/m).map((part, index) => index % 2 === 1 ? part
    : part.split(/(`[^`\n]*`)/).map((piece, inner) => inner % 2 === 1 ? piece : prose(piece)).join("")).join("");
}
