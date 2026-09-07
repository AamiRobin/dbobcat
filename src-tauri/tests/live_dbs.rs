//! End-to-end smoke test against docker-hosted MySQL and Postgres.
//! Skipped unless `MURMELI_PG_URL` / `MURMELI_MY_URL` are set so the
//! regular `cargo test` run stays hermetic.
//!
//! Brings up:
//!   docker run -d --name murmeli-pg -e POSTGRES_PASSWORD=test \
//!     -e POSTGRES_USER=test -e POSTGRES_DB=murmeli -p 5432:5432 \
//!     postgres:16-alpine
//!   docker run -d --name murmeli-my -e MYSQL_ROOT_PASSWORD=test \
//!     -e MYSQL_DATABASE=murmeli -p 3306:3306 mysql:8
//!
//! Then run:
//!   MURMELI_PG_URL=postgres://test:test@127.0.0.1:5432/murmeli \
//!   MURMELI_MY_URL=mysql://root:test@127.0.0.1:3306/murmeli \
//!   cargo test --test live_dbs -- --nocapture

use std::env;

use murmeli_lib::connections::manager::open_driver;
use murmeli_lib::connections::{
    QueryPageRequest, ResolvedConnectionConfig, RowValue, SslMode,
};
use murmeli_lib::connections::dialect::SqlDialect;

fn pg_url() -> Option<String> {
    env::var("MURMELI_PG_URL").ok()
}

fn my_url() -> Option<String> {
    env::var("MURMELI_MY_URL").ok()
}

fn parse(url: &str) -> ResolvedConnectionConfig {
    let stripped = url.split("://").nth(1).expect("scheme");
    let (auth_host, database) = match stripped.split_once('/') {
        Some((h, d)) => (h, Some(d.to_string())),
        None => (stripped, None),
    };
    let (auth, host_port) = auth_host.split_once('@').expect("user@host:port");
    let (user, password) = match auth.split_once(':') {
        Some((u, p)) => (u.to_string(), Some(p.to_string())),
        None => (auth.to_string(), None),
    };
    let (host, port_str) = host_port.split_once(':').expect("host:port");
    let port: u16 = port_str.parse().expect("port");

    let engine = if url.starts_with("postgres") {
        SqlDialect::Postgres
    } else {
        SqlDialect::Mysql
    };

    ResolvedConnectionConfig {
        ssl_files: None,
        engine,
        host: host.to_string(),
        port,
        user,
        password,
        database,
        ssl_mode: SslMode::Disabled,
        ssh: None,
    }
}

#[tokio::test]
async fn live_pg_full_path() {
    let Some(url) = pg_url() else {
        eprintln!("skipping: MURMELI_PG_URL not set");
        return;
    };
    let cfg = parse(&url);
    let mut driver = open_driver(&cfg).await.expect("postgres connect");
    let label = driver.server_label().to_lowercase();
    assert!(label.contains("postgres"), "label = {label}");

    let dbs = driver.list_databases().await.expect("list databases");
    assert!(!dbs.is_empty(), "at least one database expected");

    // PG exposes schemas, not databases, for table listing. The convention
    // used by the UI's `db_list_tables(connId, db)` is "database == schema
    // for the purpose of object lookup"; for a default install that means
    // `public`. See docs/PG-SCHEMAS.md (todo) if/when we add a real schema
    // picker in the tree.
    let schema = "public";
    let tables = driver.list_tables(schema).await.expect("list tables");
    let names: Vec<_> = tables.iter().map(|t| t.name.clone()).collect();
    assert!(names.contains(&"books".to_string()), "books table present");
    assert!(names.contains(&"authors".to_string()), "authors table present");

    let cols = driver
        .describe_table(schema, "books")
        .await
        .expect("describe books");
    let col_names: Vec<_> = cols.iter().map(|c| c.name.clone()).collect();
    assert!(col_names.contains(&"id".to_string()));
    assert!(col_names.contains(&"title".to_string()));
    assert!(col_names.contains(&"author_id".to_string()));
    let id_col = cols.iter().find(|c| c.name == "id").expect("id col");
    assert!(id_col.is_primary_key(), "id is primary key");
    let author_id = cols.iter().find(|c| c.name == "author_id").expect("fk");
    assert!(!author_id.is_primary_key());

    let page = driver
        .query_page(&QueryPageRequest {
            db: schema.to_string(),
            table: "books".to_string(),
            page_size: 100,
            offset: 0,
            order_by: vec![],
            filters: vec![],
        })
        .await
        .expect("query page books");
    assert!(page.rows.len() >= 5, "5 seeded books, got {}", page.rows.len());

    let _ = driver.close().await;
}

#[tokio::test]
async fn live_my_full_path() {
    let Some(url) = my_url() else {
        eprintln!("skipping: MURMELI_MY_URL not set");
        return;
    };
    let cfg = parse(&url);
    let mut driver = open_driver(&cfg).await.expect("mysql connect");
    let label = driver.server_label().to_lowercase();
    assert!(label.contains("mysql"), "label = {label}");

    let dbs = driver.list_databases().await.expect("list dbs");
    assert!(dbs.iter().any(|d| d.name == "murmeli"));

    let tables = driver.list_tables("murmeli").await.expect("list tables");
    let names: Vec<_> = tables.iter().map(|t| t.name.clone()).collect();
    assert!(names.contains(&"customers".to_string()));
    assert!(names.contains(&"orders".to_string()));

    let cols = driver
        .describe_table("murmeli", "orders")
        .await
        .expect("describe orders");
    assert!(cols.iter().any(|c| c.name == "total"));
    assert!(cols.iter().any(|c| c.name == "customer_id"));

    let page = driver
        .query_page(&QueryPageRequest {
            db: "murmeli".to_string(),
            table: "orders".to_string(),
            page_size: 100,
            offset: 0,
            order_by: vec![],
            filters: vec![],
        })
        .await
        .expect("query orders");
    assert!(page.rows.len() >= 5, "5 seeded orders, got {}", page.rows.len());
    // `total` is DECIMAL(10,2); backend surfaces DECIMAL as string (no
    // Numeric variant in RowValue today — confirmed in mod.rs).
    // Columns arrive in ORDINAL_POSITION order: id, customer_id, total, placed_at.
    match &page.rows[0][2] {
        RowValue::Str(s) => assert!(s.parse::<f64>().is_ok(), "DECIMAL parses: {s}"),
        other => panic!("expected Str total at index 2, got {other:?}"),
    }

    let _ = driver.close().await;
}
