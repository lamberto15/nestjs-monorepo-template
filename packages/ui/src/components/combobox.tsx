import type * as React from "react";

import * as ComboboxPrimitive from "@diceui/combobox";
import { cn } from "cn";
import { ChevronDown, X, Check } from "lucide-react";

const Combobox = (({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Root>) => {
  return (
    <ComboboxPrimitive.Root
      data-slot="combobox"
      className={cn(className)}
      {...props}
    />
  );
}) as ComboboxPrimitive.ComboboxRootComponentProps;

function ComboboxLabel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Label>) {
  return (
    <ComboboxPrimitive.Label
      data-slot="combobox-label"
      className={cn("px-0.5 py-1 text-xs font-medium", className)}
      {...props}
    />
  );
}

function ComboboxAnchor({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Anchor>) {
  return (
    <ComboboxPrimitive.Anchor
      data-slot="combobox-anchor"
      className={cn("relative flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-3 py-1 data-focused:ring-1 data-focused:ring-ring", className)}
      {...props}
    />
  );
}

function ComboboxInput({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Input>) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn("flex h-8 w-full rounded-lg bg-transparent text-base placeholder:text-muted-foreground focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 md:text-sm", className)}
      {...props}
    />
  );
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Trigger>) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("flex shrink-0 items-center justify-center rounded-e-lg border-input bg-transparent text-muted-foreground transition-colors hover:text-foreground/80 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50", className)}
      {...props}
    >
      {children || (
        <ChevronDown className="size-4" />
      )}
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxCancel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Cancel>) {
  return (
    <ComboboxPrimitive.Cancel
      data-slot="combobox-cancel"
      className={cn("absolute top-1/2 end-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-background opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none", className)}
      {...props}
    />
  );
}

function ComboboxBadgeList({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.BadgeList>) {
  return (
    <ComboboxPrimitive.BadgeList
      data-slot="combobox-badge-list"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

function ComboboxBadgeItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.BadgeItem>) {
  return (
    <ComboboxPrimitive.BadgeItem
      data-slot="combobox-badge-item"
      className={cn("inline-flex items-center justify-between gap-1 rounded-sm bg-secondary px-2 py-0.5", className)}
      {...props}
    >
      <span className="truncate text-[13px] text-secondary-foreground">{children}</span>
      <ComboboxPrimitive.BadgeItemDelete
        data-slot="combobox-badge-item-delete"
        className="shrink-0 rounded p-0.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden data-highlighted:bg-destructive"
      >
        <X className="size-3" />
      </ComboboxPrimitive.BadgeItemDelete>
    </ComboboxPrimitive.BadgeItem>
  );
}

function ComboboxContent({
  sideOffset = 6,
  className,
  children,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Content>) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Content
        data-slot="combobox-content"
        sideOffset={sideOffset}
        className={cn("relative z-50 max-h-fit min-w-(--dice-anchor-width) origin-(--dice-transform-origin) overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95", className, )}
        {...props}
      >
        {children}
      </ComboboxPrimitive.Content>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxLoading({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Loading>) {
  return (
    <ComboboxPrimitive.Loading
      data-slot="combobox-loading"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    >
      Loading...
    </ComboboxPrimitive.Loading>
  );
}

function ComboboxEmpty({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Empty>) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function ComboboxGroup({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Group>) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn("overflow-hidden", className)}
      {...props}
    />
  );
}

function ComboboxGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.GroupLabel>) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-group-label"
      className={cn("px-1.5 py-1 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  outset,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Item> & {
  outset?: boolean;
}) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center rounded-md py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        outset ? "pe-8 ps-2" : "pe-2 ps-8",
        className,
      )}
      {...props}
    >
      <ComboboxPrimitive.ItemIndicator
        className={cn("absolute flex size-3.5 items-center justify-center", outset ? "end-2" : "start-2")}
      >
        <Check className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
      <ComboboxPrimitive.ItemText>{children}</ComboboxPrimitive.ItemText>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Separator>) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("-mx-1 my-1 h-px bg-muted", className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxAnchor,
  ComboboxBadgeItem,
  ComboboxBadgeList,
  ComboboxCancel,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxLoading,
  ComboboxSeparator,
  ComboboxTrigger,
};
