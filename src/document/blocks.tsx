import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ShelfTheme } from '../theme/tokens';
import { formatAmount, formatRef, formatSiteDate } from './format';
import type { AmountLine, Block, SourceRef } from './siteSpec';

export type OpenLink = (url: string) => void;
export const defaultOpenLink: OpenLink = (url) => {
  Linking.openURL(url).catch(() => undefined);
};

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Text with http(s) links made pressable (opened through `Linking`, or `onOpenLink`). Everything else stays plain text. */
export function LinkedText({ children, theme, onOpenLink = defaultOpenLink, style }: { children: string; theme: ShelfTheme; onOpenLink?: OpenLink; style?: object }): React.ReactElement {
  const parts = children.split(URL_RE);
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} accessibilityRole="link" onPress={() => onOpenLink(part)} style={{ color: theme.colors.accentText, textDecorationLine: 'underline' }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

interface Ctx {
  theme: ShelfTheme;
  onOpenLink?: OpenLink;
}

function Section({ title, theme, testID, children }: { title: string; theme: ShelfTheme; testID: string; children: React.ReactNode }) {
  return (
    <View testID={testID} style={[styles.section, { paddingVertical: theme.space.lg, paddingHorizontal: theme.space.lg, borderTopColor: theme.colors.lineSoft }]}>
      <Text accessibilityRole="header" style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: theme.space.sm }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Src({ source, theme }: { source?: SourceRef; theme: ShelfTheme }) {
  if (!source) return null;
  return <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans, marginTop: 2 }}>{formatRef(source)}</Text>;
}

function Body({ children, ctx, strong }: { children: string; ctx: Ctx; strong?: boolean }) {
  const { theme } = ctx;
  return (
    <LinkedText theme={theme} onOpenLink={ctx.onOpenLink} style={{ color: theme.colors.fg, fontSize: theme.fontSize.md, fontFamily: theme.fonts.sans, fontWeight: strong ? '600' : '400' }}>
      {children}
    </LinkedText>
  );
}

function AmountRow({ line, ctx, big }: { line: AmountLine; ctx: Ctx; big?: boolean }) {
  const { theme } = ctx;
  return (
    <View style={styles.amountRow}>
      <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.sm, fontFamily: theme.fonts.sans, flexShrink: 1 }}>{line.label}</Text>
      <Text style={{ color: theme.colors.fg, fontSize: big ? theme.fontSize.xl : theme.fontSize.md, fontFamily: theme.fonts.mono, fontWeight: big ? '600' : '400', marginLeft: theme.space.md }}>
        {formatAmount(line.value, line.currency)}
      </Text>
    </View>
  );
}

function PartyView({ role, p, ctx }: { role: string; p: { name: string; lines?: string[]; source?: SourceRef }; ctx: Ctx }) {
  const { theme } = ctx;
  return (
    <View style={{ marginBottom: theme.space.md }} testID={`site-party-${role.toLowerCase()}`}>
      <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans }}>{role}</Text>
      <Body ctx={ctx} strong>{p.name}</Body>
      {p.lines?.map((l, i) => (
        <Body key={i} ctx={ctx}>{l}</Body>
      ))}
      <Src source={p.source} theme={theme} />
    </View>
  );
}

/** Draws one block. Tables are numbered by the caller (`tableNumber`/`tableCount`) so several read as "Items 1 of 3". */
export function SiteBlock({ block, theme, onOpenLink, tableNumber = 1, tableCount = 1 }: { block: Block; theme: ShelfTheme; onOpenLink?: OpenLink; tableNumber?: number; tableCount?: number }): React.ReactElement {
  const ctx: Ctx = { theme, onOpenLink };
  switch (block.type) {
    case 'hero': {
      const p = block.props;
      const meta = [p.issuer, p.date ? formatSiteDate(p.date) : undefined].filter(Boolean).join(' · ');
      return (
        <View testID="site-hero" style={{ padding: theme.space.lg }}>
          <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans, textTransform: 'uppercase', letterSpacing: 0.6 }}>{p.kind}</Text>
          <Text accessibilityRole="header" style={{ color: theme.colors.fg, fontSize: theme.fontSize.xl, fontFamily: theme.fonts.sans, fontWeight: '600', marginTop: theme.space.xs }}>
            {p.title}
          </Text>
          {meta ? <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.sm, fontFamily: theme.fonts.sans, marginTop: theme.space.xs }}>{meta}</Text> : null}
        </View>
      );
    }
    case 'summary':
      return (
        <Section title="Summary" theme={theme} testID="site-summary">
          <Body ctx={ctx}>{block.props.text}</Body>
          <Src source={block.props.source} theme={theme} />
        </Section>
      );
    case 'key_facts':
      return (
        <Section title="Key facts" theme={theme} testID="site-key-facts">
          {block.props.items.map((it, i) => (
            <View key={i} style={{ marginBottom: theme.space.md }}>
              <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans }}>{it.label}</Text>
              <Body ctx={ctx}>{it.value}</Body>
              <Src source={it.source} theme={theme} />
            </View>
          ))}
        </Section>
      );
    case 'amount':
      return (
        <Section title={block.props.label} theme={theme} testID="site-amount">
          <AmountRow line={{ label: 'Total', value: block.props.value, currency: block.props.currency }} ctx={ctx} big />
          <Src source={block.props.source} theme={theme} />
          {block.props.totals?.map((t, i) => (
            <View key={i}>
              <AmountRow line={t} ctx={ctx} />
              <Src source={t.source} theme={theme} />
            </View>
          ))}
        </Section>
      );
    case 'parties':
      return (
        <Section title="Parties" theme={theme} testID="site-parties">
          {block.props.from ? <PartyView role="From" p={block.props.from} ctx={ctx} /> : null}
          {block.props.to ? <PartyView role="To" p={block.props.to} ctx={ctx} /> : null}
        </Section>
      );
    case 'timeline':
      return (
        <Section title="Timeline" theme={theme} testID="site-timeline">
          {block.props.items.map((it, i) => (
            <View key={i} style={[styles.timelineRow, { marginBottom: theme.space.sm }]}>
              <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.sm, fontFamily: theme.fonts.mono, width: 104 }}>{formatSiteDate(it.date)}</Text>
              <View style={{ flex: 1 }}>
                <Body ctx={ctx}>{it.label}</Body>
                <Src source={it.source} theme={theme} />
              </View>
            </View>
          ))}
        </Section>
      );
    case 'table': {
      const p = block.props;
      return (
        <Section title={tableCount > 1 ? `Items ${tableNumber} of ${tableCount}` : 'Items'} theme={theme} testID={tableCount > 1 ? `site-table-${tableNumber}` : 'site-table'}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View style={[styles.tableRow, { borderBottomColor: theme.colors.line }]}>
                {p.columns.map((c, i) => (
                  <Text key={i} style={[styles.cell, { color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans, fontWeight: '600' }]}>{c}</Text>
                ))}
              </View>
              {p.rows.map((row, r) => (
                <View key={r} style={[styles.tableRow, { borderBottomColor: theme.colors.lineSoft }]}>
                  {row.map((c, i) => (
                    <Text key={i} style={[styles.cell, { color: theme.colors.fg, fontSize: theme.fontSize.sm, fontFamily: theme.fonts.sans }]}>{c}</Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          <Src source={p.source} theme={theme} />
        </Section>
      );
    }
    case 'source':
      return (
        <Section title="Source" theme={theme} testID="site-source">
          <Body ctx={ctx}>{block.props.note}</Body>
          {block.props.pages ? <Text style={{ color: theme.colors.muted, fontSize: theme.fontSize.xs, fontFamily: theme.fonts.sans, marginTop: 2 }}>{block.props.pages === 1 ? '1 page' : `${block.props.pages} pages`}</Text> : null}
        </Section>
      );
  }
}

const styles = StyleSheet.create({
  section: { borderTopWidth: StyleSheet.hairlineWidth },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  timelineRow: { flexDirection: 'row' },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { width: 128, paddingVertical: 6, paddingRight: 8 },
});
