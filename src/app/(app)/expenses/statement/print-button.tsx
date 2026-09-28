"use client";

import { buttonClass } from "../../button-style";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={`${buttonClass("secondary")} print:hidden`}
    >
      Print
    </button>
  );
}
