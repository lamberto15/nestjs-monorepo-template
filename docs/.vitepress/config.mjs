// docs/ is canonical on GitHub and in the generated site.
// Plain ESM config so the version-pinned pnpm dlx CLI can load it.
const base = process.env.DOCS_BASE ?? '/';
if (base !== './' && !/^\/(?:[^/]+\/)*$/.test(base)) {
  throw new Error('DOCS_BASE must be /, ./, or start and end with /.');
}
const item = (text, link) => ({ text, link });
const group = (text, entries) => ({
  text,
  items: entries.map(([title, link]) => item(title, link)),
});
const audience = [
  group('Evaluate', [
    ['Overview', '/nontechnical/'],
    ['What the template is', '/nontechnical/what-it-is'],
    ['Decision guide', '/nontechnical/decision-guide'],
    ['Capabilities and limits', '/nontechnical/capabilities-and-limits'],
    ['Adoption and operations', '/nontechnical/adoption-and-operations'],
    ['FAQ', '/nontechnical/faq'],
  ]),
];
const technical = [
  group('Build and understand', [
    ['Technical home', '/technical/'],
    ['Quickstart', '/technical/quickstart'],
    ['Architecture map', '/technical/system-map'],
    ['Code-based audit', '/technical/implementation-audit'],
    ['Monorepo', '/monorepo'],
    ['Architecture reference', '/architecture'],
    ['Development', '/development'],
    ['Adding a feature', '/adding-a-feature'],
    ['API conventions', '/api-conventions'],
    ['Configuration', '/configuration'],
  ]),
  group('Identity and data', [
    ['Identity boundaries', '/identity'],
    ['Authentication', '/auth'],
    ['Permissions', '/permissions'],
    ['Tenancy', '/tenancy'],
    ['Encryption', '/encryption'],
    ['Retention', '/retention'],
    ['Money', '/money'],
    ['Languages and time', '/i18n-and-time'],
    ['Usage and quotas', '/usage'],
  ]),
  group('Application platform', [
    ['Background jobs', '/background-work'],
    ['Webhooks and realtime', '/webhooks-and-realtime'],
    ['Approvals', '/approvals'],
    ['Automation rules', '/automations'],
    ['Notifications', '/notifications'],
    ['Tags', '/tags'],
    ['Comments', '/comments'],
    ['Attachments', '/attachments'],
    ['Revisions', '/revisions'],
    ['Custom fields', '/custom-fields'],
    ['Forms', '/forms'],
    ['Saved views', '/saved-views'],
    ['Record templates', '/templates'],
    ['Dependent choices', '/choices'],
    ['Sequences', '/sequences'],
    ['Data transfer', '/data-transfer'],
    ['Import limits', '/import-limits'],
    ['Bulk operations', '/bulk-operations'],
    ['Reports', '/reports'],
    ['Documents', '/documents'],
    ['AI', '/ai'],
    ['Email deliverability', '/deliverability'],
    ['Branding', '/branding'],
    ['Settings', '/settings'],
  ]),
  group('Operate and maintain', [
    ['Release checklist', '/technical/release-and-operations-checklist'],
    ['Deployment', '/deployment'],
    ['Rolling updates', '/deploy-rolling'],
    ['Blue-green', '/deploy-blue-green'],
    ['Swarm', '/deploy-swarm'],
    ['Kubernetes', '/deploy-kubernetes'],
    ['Single-node K3s', '/deploy-k3s'],
    ['CI runtime', '/ci-runtime'],
    ['Build version', '/build-version'],
    ['Releases', '/releases'],
    ['Upgrading', '/upgrading'],
    ['Pitfalls', '/pitfalls'],
    ['Roadmap', '/roadmap'],
    ['Docs tooling', '/documentation-tooling'],
    ['Docs maintenance', '/documentation-maintenance'],
  ]),
];
export default {
  lang: 'en-US',
  title: 'NestJS Monorepo Template',
  description:
    'Separate project evaluation and technical engineering documentation, grounded in repository source.',
  base,
  lastUpdated: true,
  // Documentation intentionally links to services on the reader's own machine.
  // VitePress still fails the build for every other broken link.
  ignoreDeadLinks: 'localhostLinks',
  // The preexisting reference manuals contain literal JSX/HTML-looking placeholders.
  // Treat authored Markdown as text, not as Vue component markup.
  markdown: {
    html: false,
    // Existing reference manuals show raw template syntax like {{#if}} and
    // {{{ body }}}. Vue would otherwise parse it as a component expression.
    // Encode literal braces in prose and inline code without altering
    // canonical Markdown, so examples display as written on GitHub and the site.
    config(md) {
      const rawText = md.renderer.rules.text;
      md.renderer.rules.text = (tokens, idx, options, env, self) => {
        const html = rawText
          ? rawText(tokens, idx, options, env, self)
          : md.utils.escapeHtml(tokens[idx].content);
        return html.replaceAll('{{', '&#123;&#123;');
      };
      const rawInline = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const html = rawInline
          ? rawInline(tokens, idx, options, env, self)
          : '<code>' + md.utils.escapeHtml(tokens[idx].content) + '</code>';
        return html.replaceAll('{{', '&#123;&#123;');
      };
    },
  },
  themeConfig: {
    nav: [
      item('Home', '/'),
      item('Evaluate', '/nontechnical/'),
      item('Technical', '/technical/'),
      item('Code audit', '/technical/implementation-audit'),
    ],
    sidebar: {
      '/nontechnical/': audience,
      '/technical/': technical,
      '/': technical,
    },
    search: { provider: 'local' },
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/lamberto15/nestjs-monorepo-template',
      },
    ],
    editLink: {
      pattern:
        'https://github.com/lamberto15/nestjs-monorepo-template/edit/main/docs/:path',
      text: 'Suggest an edit on GitHub',
    },
    footer: {
      message:
        'PolyForm Noncommercial 1.0.0. Commercial use requires separate permission.',
    },
  },
};
