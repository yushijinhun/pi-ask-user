import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("pi-ask-user.footer");
const LABEL = "[Ask On]";

interface FooterState {
   enabled: boolean;
}

type FooterPrototype = typeof FooterComponent.prototype & {
   [PATCH_KEY]?: FooterState;
};

// Match pi-telegram-notification's label placement on the existing stats line.
function appendLabel(lines: string[], width: number): string[] {
   if (lines.length < 2 || width <= 0) return lines;

   const line = lines[1];
   const gap = / {2,}/.exec(line);
   const left = gap ? line.slice(0, gap.index) : line;
   const right = gap ? line.slice(gap.index + gap[0].length) : "";
   const suffix = ` ${LABEL}`;
   const suffixWidth = visibleWidth(suffix);

   let merged: string;
   if (width < suffixWidth) {
      merged = truncateToWidth(LABEL, width, "");
   } else {
      const stats = truncateToWidth(left, width - suffixWidth, "");
      merged = `${stats}${suffix}`;
      const remaining = width - visibleWidth(merged);
      if (right && remaining > 2) {
         const model = truncateToWidth(right, remaining - 2, "");
         merged += " ".repeat(remaining - visibleWidth(model)) + model;
      }
   }

   const result = [...lines];
   result[1] = merged;
   return result;
}

// Reuse the wrapper on /reload and preserve notification/token-speed wrappers.
export function installAskFooter(): (enabled: boolean) => void {
   const prototype = FooterComponent.prototype as FooterPrototype;
   let state = prototype[PATCH_KEY];
   if (!state) {
      state = { enabled: false };
      prototype[PATCH_KEY] = state;
      const shared = state;
      const render = prototype.render;
      prototype.render = function (width: number): string[] {
         const lines = render.call(this, width);
         return shared.enabled ? appendLabel(lines, width) : lines;
      };
   }
   state.enabled = false;
   const shared = state;
   return (enabled) => { shared.enabled = enabled; };
}
