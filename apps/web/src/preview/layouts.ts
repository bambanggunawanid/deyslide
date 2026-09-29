import type { Component } from 'vue'
import ThemeCover from '@slidev/theme-default/layouts/cover.vue'
import ThemeFact from '@slidev/theme-default/layouts/fact.vue'
import ThemeIntro from '@slidev/theme-default/layouts/intro.vue'
import ThemeQuote from '@slidev/theme-default/layouts/quote.vue'
import ThemeSection from '@slidev/theme-default/layouts/section.vue'
import ThemeStatement from '@slidev/theme-default/layouts/statement.vue'
import Center from '@slidev/client/layouts/center.vue'
import Default from '@slidev/client/layouts/default.vue'
import End from '@slidev/client/layouts/end.vue'
import Full from '@slidev/client/layouts/full.vue'
import None from '@slidev/client/layouts/none.vue'
import TwoColsHeader from '@slidev/client/layouts/two-cols-header.vue'
import TwoCols from '@slidev/client/layouts/two-cols.vue'

/** Slidev's built in layouts, with the default theme's versions where it has them. */
export const LAYOUTS: Record<string, Component> = {
  'default': Default,
  'center': Center,
  'cover': ThemeCover,
  'end': End,
  'fact': ThemeFact,
  'full': Full,
  'intro': ThemeIntro,
  'none': None,
  'quote': ThemeQuote,
  'section': ThemeSection,
  'statement': ThemeStatement,
  'two-cols': TwoCols,
  'two-cols-header': TwoColsHeader,
}
