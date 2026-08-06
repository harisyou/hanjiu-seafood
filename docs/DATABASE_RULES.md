# Haris OS Database Rules

The database is a business record, not only application state. Schema and data
changes must preserve the history needed for operations, customer service,
analytics, and finance.

## Entity rules

### Products are never deleted

Products become hidden, archived, or otherwise unavailable. Existing order and
reporting references must remain valid.

### Variants can become unavailable

Variants use availability or archival state when they can no longer be sold.
Their IDs, names, and historical order references remain intact.

### Orders are permanent

Orders are never deleted. Cancellation and other lifecycle changes are recorded
as statuses. Corrections must be auditable and must not erase the original
business event.

### Customers are permanent

Customer records are retained and merged or archived carefully when necessary.
Deletion is not the normal response to duplication or inactivity. Privacy or
legal deletion requests require an explicit, reviewed process.

### Inventory changes over time

Current inventory is mutable operational state. Future inventory management
must record adjustments or events so the system can explain why stock changed.
Inventory cannot be negative.

## Historical data rules

- Always preserve historical business data.
- Order items snapshot the product, variant, price, and quantity used at the time
  of ordering.
- Catalog edits do not update historical orders.
- Foreign-key behavior must not erase business history.
- Prefer status fields and timestamps over destructive deletion.
- Database migrations must be additive or include a reviewed, reversible data
  migration plan.
- Apply constraints for valid states and values.
- Enable Row Level Security on exposed tables and grant the minimum required
  access.
- Back up data before high-risk migrations and document recovery steps.
- Never run bulk destructive operations without an explicit target, review, and
  recovery plan.
