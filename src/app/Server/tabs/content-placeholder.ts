/**
 * The picture drawn for an installed item that ships no icon of its own.
 *
 * UI asset (AGENTS.md § 3): a constant, no filesystem and no network. It is a
 * `data:` URL rather than a file on disk for two reasons — there is nothing to
 * install or resolve at runtime (which would otherwise have to work from the
 * source tree, from `bun build`'s output and from a standalone executable
 * alike), and a *constant string* is exactly the identity `<image source>`
 * wants: `hooks/use-server-content.ts` rebuilds its listing every 15 s, and a
 * source whose identity changed each round would reload every picture on screen
 * twice a minute.
 *
 * **What it is**: a 32×32 RGBA PNG of a cardboard shipping box — the same "some
 * package, we don't know which" idea every registry uses for a project that
 * published no logo. Its own colours rather than the theme's, because these are
 * image bytes and not text.
 *
 * **Keep any replacement to one bold shape.** The icon box is six cells by
 * three, which the Unicode-block renderer paints as roughly twelve quadrants by
 * six, so interior detail simply is not resolvable — a rounded frame drawn at
 * 32×32 lost its left edge to that downsample before this asset replaced it.
 *
 * **Its transparent corners depend on the icon box painting a background.**
 * OpenTUI's block renderer blends a sampled alpha into whatever the frame buffer
 * already holds, and an unpainted cell holds *black*, so a transparent ground
 * draws as black squares unless something has painted the cell first. `Content.tsx`
 * gives the box an explicit `backgroundColor` for exactly this reason; that is
 * one fact in two files, so do not drop it there thinking it is decoration.
 *
 * Inlined as a `data:` URL rather than committed as a binary so the tab has no
 * asset to resolve at runtime.
 */

/**
 * A `data:` URL holding the placeholder icon, suitable for an `<image source>`.
 *
 * Module-level and frozen by convention: pass this exact value through rather
 * than rebuilding an equivalent string per render.
 */
export const PLACEHOLDER_ICON =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAS2SURBVFiFzZdZbFRVGMf/567Tmbm9nc7WFsZSS8sMNbYokpDg9iDFJiR1oSZtJNEHYxMfNCFRTI01hNpo1PCgxhBDIAFlMbxIsE2wgEbbaCQYSmmBsjW0nW7T6ax3Oz6Urd5ZOlMwfo/f8v9+55zvnpwLLMEGD7Y1DB5sa1iKBsmn6OKRD9bEZ8P7w1PjAVACu8M5YnPKW6pe2tn7QAGCh9rt48nIvkhwrFHXtAW1hGUhuT2npEK5seKF9tB9BzjX/d1hRdVejA+dZKgSTZvHiaIuub3frm62thLSbiwZYOjEnjfjQtkuFPoEAKBaEurwr1Cu9oEaWtq6AlkOFTodb1Rt6TycF8DFo22VMcPRhYc3VoJhTXEjMonkYDe0iUsZ1SWna9gquTZXNbWfXxTAlT3tlhgf3T0XHG/WVIVh7C6I/npwrsqUPbSpYSQHumBEJtJysBxHJY/3J48oNXma2iNpAQYOvLc9MjXxYTIWFf8twnmqIfrrwVgd5g7UgDJyBspQD6gaSwsiWm1Ju9P9UaC582MTwM3jO94ZvXLj8/hcOK0AGBaCby3E6mcA1sQIqsahXDoN5dofAFLPn1V2wFfz6Gb3k60/AgB3O8AC6z0OK5IOCVPBKaiJhLna0KFc64M61g9h5dMQlj8GkLubSPgCiIF68L7HkbjQBX3y8p0YL1rgWVkN5/JyUAYrbvu5BQ1AIUJDqbsIUZ1gZiwIw9DNK01GkOw/Bm3kL4iBerBFDy3cKLsL1rUt0CaGoFzoRpFLRmmVHwzHmbTMHgCEUNg5CpvPi9mYitmJSQDUlKfPjiLWuxd8SQCi/zkQi7wgLjlLUfT867BEBlO1mYc1OWQfGNk3D0J1FBUwKCtfBovdnkaCQh07j8gvX0G5dApU18BpUXgdPIpX+MFbbGmbpwQAy0FY8wqE2pdBLIUAAJ6q8Dpt8CxfBk4QUivpKrRrv0MO/wlvRRU4yZOxcVoAY/oKEqd3wZgbg2V9K/jqjQArABQoYDSUlTrhLCkBw9wtJYTA6SvHqqeeRXFJ6YLBzGamGWDL6kAsdmhX+6CPngNfvRHihregDXZBH+sHoQbsAlDgK0EoHAfheJT5ayDa5o/IPCk5AhjTw+ADDbBseALqYBeUs4fAOFaAX1UPmpiDEbo+D0p1OCUB8up1GRvQLEgmAJoIQznzPZjiCgj+TaBKDMbMVSR7v8lpZQBAktNgZy9nzEn5GQK3ZuG3r3NuCkpB9ATYmfNgYjezpqcFyNeIEgJ/82eAZn0KPBgAgAJ08aNovgf+Y/v/ADCE68vzkZyrUcZAvwnAvWn7Z3yR+31GEJMPsPeAQekmqa6l57bHtGTas8cSTIzsVudCzVTXsh5RtovoloVA0Cmx/Bekpkm5N5B2z8dPfFJJY7Ef1EioNtMFmwXAALCfQN8m1W4NpkrIeujB7o4GLRbdq8cjrpwACDnJMPrb9kdePZtJf9FTFzzesUOLzryrqwqfCYACNwC0ybUt+xajm9uvWc+XdiM+tU+PhBoNXSf3AhAgZgCfFhYqnaTitRQPyvsAcAfk2M463VAPaNGZgBxYRwEc0Th9W3HN1uv56OVtwe6OhvDfB/xL0fgHihq92tfZ4ygAAAAASUVORK5CYII=";
