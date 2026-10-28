# Dependent choices

Dropdowns whose choices depend on another field: pick a customer, then one of
its projects. The choices come from **providers registered by trusted server
code**: never a URL or query from a request. `apps/api/src/platform/choices/`.

- **Provider** (`ChoiceProvider`): a `key`, the **typed parameters** it takes
  (`{ customerId: 'uuid' }`, the allowlist; all required), `mayUse(principal)`,
  `options({ principal, params, q, limit })` and `has({ principal, params,
value })`. What it returns is already what the caller may see; its queries are
  its own (Drizzle, behind row-level security) and bounded by `limit`.
- **Set** (`ChoiceSet`): fields that choose together, each naming a provider and
  which **sibling field** fills each parameter. Parameters are simple field
  references, not expressions (computed values are a different feature):

```ts
registry.set({
  key: 'unit-member',
  label: 'A unit, then one of its members',
  fields: {
    unit: { provider: 'organizational-units' },
    member: { provider: 'unit-members', params: { unitId: 'unit' } }, // member depends on unit
  },
});
```

A set is checked when registered, and a bad one fails the boot: the provider
exists, exactly its parameters are filled, from fields of the set, no field
depends on itself, **no cycles** (`one → two → one`), and no chain deeper than 4.
A feature registers from one injectable's constructor, providers first, then
sets (`ChoicesBuiltins` is the example: the tenant's units, then a unit's current
members).

## Routes

```http
GET /v1/choices                                  # the sets, with the fields whose provider you may use
GET /v1/choices/unit-member                      # fields parents first, each with `dependsOn`
GET /v1/choices/unit-member/member/options?parent.unit=<id>&q=ann&limit=20
→ { "set": "unit-member", "field": "member", "parents": { "unit": "<id>" },
    "items": [{ "value": "<user id>", "label": "Ann" }], "hasMore": false }

POST /v1/choices/unit-member/validate            # 204, or 400 per field
{ "values": { "unit": "<id>", "member": "<user id>" } }
```

- **Bounded**: `limit` is 20 by default, at most 50; the provider is asked for one
  more to say `hasMore` (no count). Narrow with `q`.
- **Typed parameters**: `parent.<field>` is required for every field the field
  depends on and must have its parameter's type (a `uuid` is one); any other
  `parent.*` is a 400 `parent.<name>`. Unknown set or field: 404; a provider the
  caller may not use: 403.
- **Filtered by access**: a provider decides what the caller sees. The built-in
  `unit-members` lists a unit's members to whoever manages users and to the
  unit's own members, and to nobody else: an empty answer, as for a unit that
  does not exist, so it never says which units have whom.

## Stale answers and changed parents

- **Invalidating a child.** When a parent changes, the child's value belongs to
  the old parent: the client clears it (`dependsOn` says which fields to clear)
  and asks for new options. The server enforces the same rule, whatever the
  client does: a child is valid only among the choices **for the parent values
  sent with it**.
- **Ignoring stale responses.** `options` echoes `parents`: a client shows an
  answer only while those are still the form's parents (an answer for an earlier
  parent is dropped).

## Validated again on write

A value is trusted only after `ChoicesService.assertValid(principal, set,
values)`: a 400 `validation_failed` with one error per field (`path` = its
name) when a value is not one of the choices the caller could pick for the
parents' values, or its parent is missing or itself not a valid choice, or a
stored label was sent instead of a value (`has()` checks the value). Absent and
`null` values are not checked (required-ness is the record's). A feature that
stores a dependent choice calls it in its service's write path, with the values
the record will hold (on a partial update, the stored values merged with the
patch); `POST /v1/choices/{set}/validate` runs the same check for a client.
Permission to set the record's own field stays the record route's (field-level
permissions, [permissions](permissions.md)).

Not in this first version: choice-typed custom fields and the generator option
(`field.choice`), the web app's cascading `Select`, caching, and the form
builder's provider picker (#549); they build on `ChoicesRegistry`.

Tests: `choices.registry.spec.ts`, `choices.service.spec.ts`,
`apps/api/test/choices.e2e-spec.ts`.
