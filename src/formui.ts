import type { FormField, FormState } from "./context.js";
import { esc } from "./util.js";

export function renderForm(state: FormState): string {
  const lines: string[] = [`<b>Form: ${esc(state.title)}</b>`, `ID: <code>${esc(state.formId)}</code>`];
  state.fields.forEach((field, index) => {
    const required = field.required ? " *" : "";
    const answer = state.answers[field.key];
    lines.push("");
    lines.push(`<b>${index + 1}. ${esc(field.title ?? field.key)}</b>${required}${field.description ? " — " + esc(field.description) : ""}`);
    if (field.options?.length) {
      lines.push(field.options.map((option) => `${answer === option.value ? "✅" : "•"} ${esc(option.label)}`).join("\n"));
    } else if (answer !== undefined) {
      lines.push(`Answer: <code>${esc(String(answer))}</code>`);
    } else {
      lines.push("<i>Reply with /formreply " + esc(state.formId) + " {\"" + esc(field.key) + "\":\"value\"}</i>");
    }
  });
  const allRequired = state.fields.filter((field) => field.required).every((field) => state.answers[field.key] !== undefined);
  lines.push("");
  lines.push(allRequired ? "<i>All required fields answered. Press Submit.</i>" : "<i>Answer the required fields (*).</i>");
  return lines.join("\n");
}

export function formKeyboard(state: FormState): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  state.fields.forEach((field, fieldIndex) => {
    if (!field.options?.length) return;
    field.options.forEach((option, optionIndex) => {
      const selected = state.answers[field.key] === option.value ? "✅ " : "";
      keyboard.push([{ text: `${selected}${option.label}`.slice(0, 64), callback_data: `fq:${fieldIndex}:${optionIndex}` }]);
    });
  });
  const allRequired = state.fields.filter((field) => field.required).every((field) => state.answers[field.key] !== undefined);
  const actions: Array<{ text: string; callback_data: string }> = [];
  if (allRequired) actions.push({ text: "✅ Submit", callback_data: "forms:submit" });
  actions.push({ text: "⛔ Cancel", callback_data: "forms:cancel" });
  keyboard.push(actions);
  return keyboard;
}
