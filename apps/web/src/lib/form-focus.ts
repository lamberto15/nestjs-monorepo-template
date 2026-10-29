/**
 * The <form> element each form's fields render in (TanStack Form knows its
 * fields, not its markup): where its first invalid control is looked for, so
 * the focus never moves into another form of the page (/onboarding has three,
 * a dialog's form sits over a page's).
 */
const formElements = new WeakMap<object, HTMLFormElement>();

/** Records the <form> a field's element is in (lib/form.tsx's fields' ref). */
export function rememberFormElement(form: object, element: Element | null) {
  const owner = element?.closest('form');
  if (owner) {
    formElements.set(form, owner);
  }
}

// A control the user can be put in. A code field's slots are divs that carry
// aria-invalid too; its <input> comes after them.
const INVALID_CONTROL = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'button',
  '[role="combobox"]',
  '[contenteditable="true"]',
]
  .map((control) => `${control}[aria-invalid="true"]`)
  .join(', ');

/**
 * After a failed submit (the form's own checks, or the API's field errors,
 * lib/errors.ts): the focus goes to the form's first invalid control, so a
 * keyboard or screen-reader user is where the error is, not on the button.
 * A frame later: the form's state changes before React renders the errors.
 */
export function focusFirstInvalid(form: object) {
  requestAnimationFrame(() => focusFirstInvalidIn(formElements.get(form)));
}

/** Moves the focus to the first invalid control in `element`, a form not of TanStack Form's. */
export function focusFirstInvalidIn(element: HTMLElement | null | undefined) {
  if (element?.isConnected) {
    element.querySelector<HTMLElement>(INVALID_CONTROL)?.focus();
  }
}
