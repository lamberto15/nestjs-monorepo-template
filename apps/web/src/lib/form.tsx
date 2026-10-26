import { createFormHook, createFormHookContexts } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@nestjs-monorepo-template/ui/components/input-otp';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Textarea } from '@nestjs-monorepo-template/ui/components/textarea';
import { LazyMarkdownEditor } from '@/components/markdown/lazy';
import { useWritesPaused } from '@/lib/mode';
import { meQuery, sessionIdentity, type Me } from '@/lib/session';
import { CircleAlertIcon } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';

// TanStack Form's form composition (its "Form Composition" guide): the
// shadcn Field markup of its TanStack Form docs, bound once, so a form is
// `<form.AppField name="email" children={(f) => <f.TextField … />} />`.

export const { fieldContext, useFieldContext, formContext, useFormContext } =
  createFormHookContexts();

/** Whether the field shows its errors: touched (or submitted) and invalid. */
function useInvalid() {
  const field = useFieldContext<unknown>();
  return field.state.meta.isTouched && !field.state.meta.isValid;
}

/**
 * The ids that tie a control to its hint and its error message. shadcn's
 * Field primitives only lay the markup out (the docs set `aria-invalid` on
 * the control and leave the rest to the form), so without `aria-describedby`
 * a screen reader announces neither. `useId` keeps the ids unique when the
 * same field name is on the page twice (a dialog over a page).
 */
function useDescribedBy(hasDescription: boolean, invalid: boolean) {
  const base = useId();
  const descriptionId = `${base}-description`;
  const errorId = `${base}-error`;
  const ids = [hasDescription && descriptionId, invalid && errorId].filter(
    Boolean,
  );
  return {
    descriptionId,
    errorId,
    describedBy: ids.length > 0 ? ids.join(' ') : undefined,
  };
}

function TextField(props: {
  label: ReactNode;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  description?: ReactNode;
  /** Next to the label (a "forgot your password?" link). */
  aside?: ReactNode;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(props.description),
    invalid,
  );
  return (
    <Field data-invalid={invalid}>
      {props.aside ? (
        <div className="flex items-center">
          <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
          <div className="ms-auto text-sm">{props.aside}</div>
        </div>
      ) : (
        <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      )}
      <Input
        id={id}
        name={field.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      />
      {props.description && (
        <FieldDescription id={descriptionId}>
          {props.description}
        </FieldDescription>
      )}
      {invalid && <FieldError id={errorId} errors={field.state.meta.errors} />}
    </Field>
  );
}

/** Longer text (a note's body): shadcn's Textarea. */
function TextAreaField(props: {
  label: ReactNode;
  description?: ReactNode;
  rows?: number;
  placeholder?: string;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(props.description),
    invalid,
  );
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Textarea
        id={id}
        name={field.name}
        rows={props.rows ?? 8}
        placeholder={props.placeholder}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      />
      {props.description && (
        <FieldDescription id={descriptionId}>
          {props.description}
        </FieldDescription>
      )}
      {invalid && <FieldError id={errorId} errors={field.state.meta.errors} />}
    </Field>
  );
}

/**
 * Longer text as Markdown, edited in a rich text editor (Tiptap, loaded when
 * the field first shows). The form's value stays the Markdown string.
 */
function MarkdownField(props: { label: ReactNode; description?: ReactNode }) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  const labelId = `${id}-label`;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(props.description),
    invalid,
  );
  return (
    <Field data-invalid={invalid}>
      <FieldLabel id={labelId}>{props.label}</FieldLabel>
      <LazyMarkdownEditor
        id={id}
        value={field.state.value}
        onChange={field.handleChange}
        onBlur={field.handleBlur}
        labelledBy={labelId}
        describedBy={describedBy}
        invalid={invalid}
      />
      {props.description && (
        <FieldDescription id={descriptionId}>
          {props.description}
        </FieldDescription>
      )}
      {invalid && <FieldError id={errorId} errors={field.state.meta.errors} />}
    </Field>
  );
}

/** A six-digit code (an authenticator's), shadcn's input-otp. */
function CodeField(props: {
  label: ReactNode;
  description?: ReactNode;
  autoFocus?: boolean;
  /** Called with the sixth digit (submits the form). */
  onComplete?: () => void;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(props.description),
    invalid,
  );
  return (
    <Field data-invalid={invalid} className="items-center">
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <InputOTP
        id={id}
        name={field.name}
        maxLength={6}
        inputMode="numeric"
        pattern="^[0-9]*$"
        autoComplete="one-time-code"
        autoFocus={props.autoFocus}
        value={field.state.value}
        onChange={field.handleChange}
        onBlur={field.handleBlur}
        onComplete={props.onComplete}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        containerClassName="justify-center"
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} aria-invalid={invalid} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      {props.description && (
        <FieldDescription id={descriptionId}>
          {props.description}
        </FieldDescription>
      )}
      {invalid && <FieldError id={errorId} errors={field.state.meta.errors} />}
    </Field>
  );
}

/** One of a list (a language, a time zone): shadcn's Select (Base UI). */
function SelectField(props: {
  label: ReactNode;
  description?: ReactNode;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  const { descriptionId, errorId, describedBy } = useDescribedBy(
    Boolean(props.description),
    invalid,
  );
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Select
        name={field.name}
        items={props.options}
        value={field.state.value || null}
        onValueChange={(value) => field.handleChange(value ?? '')}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={invalid}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder={props.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {props.description && (
        <FieldDescription id={descriptionId}>
          {props.description}
        </FieldDescription>
      )}
      {invalid && <FieldError id={errorId} errors={field.state.meta.errors} />}
    </Field>
  );
}

/**
 * The submit button: disabled and spinning while the form submits, and
 * disabled while the API refuses writes (read-only or maintenance mode, the
 * banner says why) unless the form's route stays open in both
 * (`allowInMaintenance`, as the API's `@AllowInMaintenance()`).
 */
function SubmitButton(props: {
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  allowInMaintenance?: boolean;
}) {
  const form = useFormContext();
  const paused = useWritesPaused() && !props.allowInMaintenance;
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(submitting) => (
        <Button
          type="submit"
          className={props.className}
          disabled={submitting || props.disabled || paused}
        >
          {submitting && <Spinner />}
          {props.children}
        </Button>
      )}
    </form.Subscribe>
  );
}

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    TextAreaField,
    MarkdownField,
    CodeField,
    SelectField,
  },
  formComponents: { SubmitButton },
});

/**
 * A form's draft belongs to the session it was begun under (`sessionIdentity`
 * in lib/session.ts: who was signed in, in which tenant, acting as whom).
 * Another tab of the same browser can re-issue the shared `__Host-sid`
 * cookie while the user types (a tenant switch, another account, an
 * impersonation — the caches reset, lib/errors.ts, but a draft is component
 * state and survives), and submitting it would then send the old session's
 * words under the new one's cookie: a note landing in the wrong tenant.
 *
 * A form behind the signed-in layout (where these live — its guard has read
 * `me` before the form mounts) calls what this returns at the top of its
 * `onSubmit`: `true` when the draft's session is gone — the form sends
 * nothing, keeps the draft, and says why; the NEXT submit is the user's own
 * decision, made under the session they can see — and `false` when the
 * draft's session is still the current one.
 */
export function useStaleDraftSession() {
  const queryClient = useQueryClient();
  const begun = useRef(
    sessionIdentity(queryClient.getQueryData<Me | null>(meQuery.queryKey)),
  );
  return () => {
    const now = sessionIdentity(
      queryClient.getQueryData<Me | null>(meQuery.queryKey),
    );
    if (now === begun.current) {
      return false;
    }
    // Warned once: the next submit is on purpose, under the new session.
    begun.current = now;
    return true;
  };
}

/** A form's error that belongs to no field (the problem's `detail`). */
export function FormAlert(props: { message?: string }) {
  if (!props.message) {
    return null;
  }
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlertIcon />
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}
