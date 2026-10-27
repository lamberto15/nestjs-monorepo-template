# Conventions: NestJS Template UI

shadcn/ui components on Base UI, styled with Tailwind 4 utility classes over
CSS-variable tokens. Neutral greyscale theme, Geist Variable font, light by
default. Every export is on `window.NestUI`.

## Setup

- Wrap the app in `<DirectionProvider direction="ltr">` (`"rtl"` for Arabic,
  together with `dir="rtl"` on `<html>`). Popups, sliders and menus read the
  text direction from it.
- Dark theme: add the `dark` class to `<html>`. The tokens switch; never
  hard-code colours per theme.
- Page background and text come from `body` (`bg-background text-foreground`);
  don't repeat them on the root.

## Styling idiom

Style with the theme's semantic utility classes, never raw colours:

| Role     | Classes                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Surfaces | `bg-background`, `bg-card`, `bg-muted`, `bg-popover`, `bg-accent`, `bg-secondary`, `bg-primary`                          |
| Text     | `text-foreground`, `text-muted-foreground`, `text-card-foreground`, `text-primary-foreground`, `text-destructive`        |
| Lines    | `border`, `border-border`, `border-input`                                                                                |
| Errors   | `text-destructive` on `bg-destructive/10`                                                                                |
| Radius   | `rounded-md`, `rounded-lg`, `rounded-xl`                                                                                 |
| Type     | `text-xs`, `text-sm` (body), `text-base`, `text-2xl`, `font-medium`                                                      |
| Layout   | `flex`, `flex-col`, `items-center`, `justify-between`, `gap-1` to `gap-8`, `p-2`, `p-4`, `w-full`, `min-w-0`, `max-w-sm` |

**Only classes the library itself uses are compiled** into `styles.css`. Grid
column classes (`grid-cols-*`), breakpoint variants (`lg:`) and large paddings
(`p-6`, `px-4`, `text-xl`) do NOT exist. For layout beyond the table above use
an inline `style` with the tokens, e.g.
`style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'calc(var(--spacing) * 4)' }}`.
Colour tokens are `var(--background)`, `var(--foreground)`, `var(--muted-foreground)`,
`var(--border)`, `var(--primary)`, `var(--destructive)`, `var(--chart-1)` to
`var(--chart-5)`; the base radius is `var(--radius)`.

Give a grid or flex child that holds a chart, table or long text `min-w-0`
(or `minmax(0, 1fr)` columns), or it widens its column and the page scrolls
sideways.

## Components

Compose the subparts rather than restyling the root: `Card` with `CardHeader`,
`CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`;
`Tabs` with `TabsList`, `TabsTrigger`, `TabsContent`; `Alert` with
`AlertTitle`, `AlertDescription`. Variants are props: `Button`
`variant="default" | "outline" | "secondary" | "ghost" | "destructive" | "link"`, `Badge` `variant`, `Card`
`size="sm"`. Mark an invalid `Input` with `aria-invalid`. Per-component props
and examples: `components/<group>/<Name>/<Name>.prompt.md` and `.d.ts`.

## Example

```jsx
const { Card, CardHeader, CardTitle, CardDescription, CardContent, Button } =
  window.NestUI;

<Card className="max-w-sm">
  <CardHeader>
    <CardTitle>Notes</CardTitle>
    <CardDescription>Everything your team wrote down.</CardDescription>
  </CardHeader>
  <CardContent className="flex items-center justify-between gap-2">
    <span className="text-sm text-muted-foreground">12 this week</span>
    <Button>Open</Button>
  </CardContent>
</Card>;
```
