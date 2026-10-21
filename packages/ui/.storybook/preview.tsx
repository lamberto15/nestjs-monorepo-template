import type { Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import { DirectionProvider } from '../src/components/direction';
import '../src/styles/globals.css';

// Toolbar: the theme (light/dark: the `.dark` class on <html>, as the app's
// ThemeProvider sets it) and the text direction (RTL for Arabic: `dir` on
// <html> plus Base UI's DirectionProvider).
const preview: Preview = {
  initialGlobals: { theme: 'light', direction: 'ltr' },
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
    direction: {
      description: 'Text direction',
      toolbar: {
        title: 'Direction',
        icon: 'transfer',
        items: [
          { value: 'ltr', title: 'LTR' },
          { value: 'rtl', title: 'RTL' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === 'dark';
      const direction = context.globals.direction === 'rtl' ? 'rtl' : 'ltr';
      useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle('dark', dark);
        root.dir = direction;
      }, [dark, direction]);
      return (
        <DirectionProvider direction={direction}>
          <div className="bg-background p-4 text-foreground">
            <Story />
          </div>
        </DirectionProvider>
      );
    },
  ],
  parameters: {
    layout: 'fullscreen',
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
  },
};

export default preview;
