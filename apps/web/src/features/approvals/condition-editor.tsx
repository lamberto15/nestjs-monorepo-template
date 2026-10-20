import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  initialOf,
  isCombinator,
  type TypeOption,
  type Typed,
} from './policy-draft';
import { TypedEditor } from './typed-editor';

/** A condition to start from: a comparison of the proposed change. */
export function defaultCondition(options: readonly TypeOption[]): Typed {
  const option =
    options.find((entry) => entry.type === 'payload') ??
    options.find((entry) => !isCombinator(entry.type)) ??
    options[0];
  return option ? initialOf(option) : { type: 'payload', params: {} };
}

/**
 * A condition (`when`): a registered one, or `all` / `any` of a list of
 * conditions, or `not` of one (docs/approvals.md, "Stages, modes, time").
 * The combinators nest, as far as the API allows (5 deep).
 */
export function ConditionEditor(props: {
  options: readonly TypeOption[];
  value: Typed;
  onChange: (next: Typed) => void;
  label: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation('approvals');
  const { options, value } = props;
  const children = Array.isArray(value.params.conditions)
    ? (value.params.conditions as Typed[])
    : [];
  const only = value.params.condition as Typed | undefined;
  const setChildren = (next: Typed[]) =>
    props.onChange({ ...value, params: { conditions: next } });
  return (
    <TypedEditor
      kind="condition"
      options={options}
      value={value}
      label={props.label}
      hideParams={isCombinator(value.type)}
      onRemove={props.onRemove}
      onChange={(next) => {
        // A combinator starts with one condition inside, so it is valid at once.
        if (next.type === 'not') {
          props.onChange({
            ...next,
            params: { condition: defaultCondition(options) },
          });
        } else if (isCombinator(next.type)) {
          props.onChange({
            ...next,
            params: { conditions: [defaultCondition(options)] },
          });
        } else {
          props.onChange(next);
        }
      }}
    >
      {value.type === 'not' && (
        <ConditionEditor
          options={options}
          value={only ?? defaultCondition(options)}
          label={t('policies.when.inner')}
          onChange={(next) =>
            props.onChange({ ...value, params: { condition: next } })
          }
        />
      )}
      {(value.type === 'all' || value.type === 'any') && (
        <div className="flex flex-col gap-2">
          {children.map((child, index) => (
            <ConditionEditor
              key={index}
              options={options}
              value={child}
              label={t('policies.when.item', { n: index + 1 })}
              onChange={(next) =>
                setChildren(children.map((c, i) => (i === index ? next : c)))
              }
              onRemove={
                children.length > 1
                  ? () => setChildren(children.filter((_, i) => i !== index))
                  : undefined
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              setChildren([...children, defaultCondition(options)])
            }
          >
            <PlusIcon />
            {t('policies.when.add')}
          </Button>
        </div>
      )}
    </TypedEditor>
  );
}
