//! Per-connection column-metadata cache.
//!
//! `describe_table` runs a live catalog query on every data-grid page,
//! search, edit post and dropdown load — yet the column list only changes
//! when DDL runs. The grid hot path therefore reads from this cache; DDL
//! entry points (`commands/objects.rs`, CSV/SQL import) and the tree
//! Refresh clear it explicitly.
//!
//! Each connection task owns one cache and processes commands serially, so
//! no locking is needed. Entries never leak across sessions.

use std::collections::HashMap;

use super::ColumnMeta;

/// Keyed by `(database, table)`. The database stays in the key even for
/// SQLite (which ignores it) so all drivers share one keying convention.
#[derive(Debug, Default)]
pub struct SchemaCache {
    entries: HashMap<(String, String), Vec<ColumnMeta>>,
}

impl SchemaCache {
    pub fn get(&self, db: &str, table: &str) -> Option<&[ColumnMeta]> {
        self.entries
            .get(&(db.to_string(), table.to_string()))
            .map(Vec::as_slice)
    }

    pub fn insert(&mut self, db: &str, table: &str, columns: Vec<ColumnMeta>) {
        self.entries
            .insert((db.to_string(), table.to_string()), columns);
    }

    /// Drop every entry. Called after DDL and by the tree Refresh.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            data_type: "varchar(10)".into(),
            nullable: false,
            key: None,
            default_value: None,
            extra: None,
            comment: None,
        }
    }

    #[test]
    fn get_insert_clear_roundtrip() {
        let mut cache = SchemaCache::default();
        assert!(cache.is_empty());

        cache.insert("shop", "customers", vec![col("id"), col("name")]);
        assert_eq!(cache.len(), 1);
        let hit = cache.get("shop", "customers").unwrap();
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[0].name, "id");

        // Distinct table / database keys don't collide.
        assert!(cache.get("shop", "orders").is_none());
        assert!(cache.get("analytics", "customers").is_none());

        cache.clear();
        assert!(cache.is_empty());
        assert!(cache.get("shop", "customers").is_none());
    }

    #[test]
    fn insert_replaces_previous_entry() {
        let mut cache = SchemaCache::default();
        cache.insert("shop", "customers", vec![col("id")]);
        cache.insert("shop", "customers", vec![col("id"), col("email")]);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("shop", "customers").unwrap().len(), 2);
    }
}
