import { createFormHook, createFormHookContexts } from '@tanstack/react-form';
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
import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';

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
      />
      {props.description && (
        <FieldDescription>{props.description}</FieldDescription>
      )}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
}

/** A six-digit code (an authenticator's), shadcn's input-otp. */
function CodeField(props: {
  label: ReactNode;
  autoFocus?: boolean;
  /** Called with the sixth digit (submits the form). */
  onComplete?: () => void;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
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
        containerClassName="justify-center"
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} aria-invalid={invalid} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
}

/** One of a list (a language, a time zone): shadcn's Select (Base UI). */
function SelectField(props: {
  label: ReactNode;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const field = useFieldContext<string>();
  const invalid = useInvalid();
  const id = `field-${field.name}`;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Select
        name={field.name}
        items={props.options}
        value={field.state.value || null}
        onValueChange={(value) => field.handleChange(value ?? '')}
      >
        <SelectTrigger id={id} className="w-full" aria-invalid={invalid}>
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
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
}

/** The submit button: disabled and spinning while the form submits. */
function SubmitButton(props: {
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(submitting) => (
        <Button
          type="submit"
          className={props.className}
          disabled={submitting || props.disabled}
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
  fieldComponents: { TextField, CodeField, SelectField },
  formComponents: { SubmitButton },
});

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
