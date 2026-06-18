import { Filter } from 'lucide-react';
import { CompactOptionMenu } from '../../components/CompactOptionMenu.js';
import {
  type MonitorSeverityFilter,
  SEVERITY_FILTER_OPTIONS,
} from './runtimeEventSeverityFilter.js';

export interface SeverityFilterMenuProps {
  /** Currently selected severity filter. Drives the active item indicator. */
  value: MonitorSeverityFilter;
  onChange: (value: MonitorSeverityFilter) => void;
}

/**
 * Compact icon menu that narrows the runtime event feed to a single severity.
 *
 * Delegates rendering to the shared {@link CompactOptionMenu} so the severity
 * filter and the materia palette sort dropdown share one accessible,
 * palette-styled popover: icon trigger, `menu`/`menuitemradio` semantics, a
 * check indicator on the active value, and outside-click/Escape close with
 * focus return. The `monitor-severity` class prefix themes it to match the
 * palette sort dropdown while keeping the monitor's styles independently
 * targetable. Options come from {@link SEVERITY_FILTER_OPTIONS}, which is built
 * from the canonical event contract severities plus an `All levels` choice.
 */
export function SeverityFilterMenu({ value, onChange }: SeverityFilterMenuProps) {
  return (
    <CompactOptionMenu<MonitorSeverityFilter>
      value={value}
      options={SEVERITY_FILTER_OPTIONS}
      onChange={onChange}
      testIdPrefix="monitor-severity"
      classPrefix="monitor-severity"
      triggerIcon={<Filter className="monitor-severity-icon" aria-hidden="true" focusable="false" />}
      triggerAriaLabel={(activeLabel) => `Filter runtime events by severity. Current filter: ${activeLabel}.`}
      triggerTitle={(activeLabel) => `Severity filter: ${activeLabel}`}
      optionTitle={(label) => `Show events: ${label}`}
    />
  );
}
