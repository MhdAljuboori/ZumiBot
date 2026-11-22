import { displayName } from '@zumibot/shared/frontmatter'
import { filterActive, NO_FILTER, type BoardFilter } from '../state/todoBoard'
import { SearchSelect } from './SearchSelect'

/**
 * The To-dos page's filters, for both views: words in a card's title or notes, its assignee and its creator, and Clear
 * when any is set. `showDone` (Grid only) is a switch, not a checkbox: the page has none. `folded` hides them on a phone
 * only (the head's Filters button opens them); a wider screen always shows them.
 */
export function TodoFilters({
  filter,
  onFilter,
  assignees,
  creators,
  folded = false,
  showDone,
  onShowDone
}: {
  filter: BoardFilter
  onFilter: (f: BoardFilter) => void
  /** Who the board's cards are for and who made them, from what it holds. */
  assignees: string[]
  creators: string[]
  folded?: boolean
  /** Grid only; absent on Kanban, whose Done column always shows. */
  showDone?: boolean
  onShowDone?: (on: boolean) => void
}) {
  const set = (patch: Partial<BoardFilter>): void => onFilter({ ...filter, ...patch })
  // A filter on someone no card has any more stays a choice, so the select never shows a blank.
  const keepAssignee =
    filter.assignee !== 'all' && filter.assignee !== 'none' && !assignees.includes(filter.assignee) ? [filter.assignee] : []
  const keepCreator = filter.creator !== 'all' && !creators.includes(filter.creator) ? [filter.creator] : []
  return (
    <div id="board-tools" className={folded ? 'board-tools folded' : 'board-tools'} data-testid="board-tools" role="search">
      <label className="board-search">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          className="field"
          data-testid="board-search"
          type="search"
          value={filter.text}
          placeholder="Search tasks"
          aria-label="Search tasks"
          autoComplete="off"
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter.text !== '') {
              e.preventDefault()
              set({ text: '' })
            }
          }}
        />
      </label>
      <SearchSelect
        className="field board-filter"
        data-testid="board-filter-assignee"
        value={filter.assignee}
        aria-label="Assignee"
        onChange={(v) => set({ assignee: v })}
      >
        <option value="all">Any assignee</option>
        <option value="user">Assigned to you</option>
        <option value="none">Unassigned</option>
        {[...assignees.filter((a) => a !== 'user'), ...keepAssignee].map((a) => (
          <option key={a} value={a}>{`Assigned to @${displayName(a)}`}</option>
        ))}
      </SearchSelect>
      <SearchSelect
        className="field board-filter"
        data-testid="board-filter"
        value={filter.creator}
        aria-label="Made by"
        onChange={(v) => set({ creator: v })}
      >
        <option value="all">Made by anyone</option>
        <option value="user">Made by you</option>
        {[...creators.filter((c) => c !== 'user'), ...keepCreator].map((c) => (
          <option key={c} value={c}>{`Made by @${displayName(c)}`}</option>
        ))}
      </SearchSelect>
      {filterActive(filter) && (
        <button type="button" className="btn small board-clear" data-testid="board-clear-filters" onClick={() => onFilter(NO_FILTER)}>
          Clear filters
        </button>
      )}
      {onShowDone && (
        <button
          type="button"
          className={showDone ? 'board-switch on' : 'board-switch'}
          data-testid="grid-show-done"
          role="switch"
          aria-checked={showDone === true}
          onClick={() => onShowDone(!showDone)}
        >
          <span className="board-switch-track" aria-hidden="true">
            <span className="board-switch-thumb" />
          </span>
          Show completed
        </button>
      )}
    </div>
  )
}
