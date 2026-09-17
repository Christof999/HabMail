/**
 * Eine Reihe Knöpfe, von denen einer gedrückt ist.
 *
 * Ein Auswahlfeld wäre zwei Klicks und verbirgt die Möglichkeiten, bis man es
 * öffnet. Hier sind es zwei bis drei kurze Wörter — die passen nebeneinander,
 * und was darunter steht, ändert sich beim Drücken sofort mit.
 *
 * Eigene Datei, seit die Signatureinstellungen nicht mehr der einzige Ort
 * sind, an dem so etwas gebraucht wird.
 */
export function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}) {
  return (
    <div className="choice-row-group">
      <span className="account-section-label">{label}</span>
      <div className="choice-row" role="group" aria-label={label}>
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            className={option === value ? 'is-active' : ''}
            aria-pressed={option === value}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}
