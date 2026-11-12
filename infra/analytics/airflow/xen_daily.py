"""Daily analytics build. Written, not run (needs Airflow, Spark/Trino and the Iceberg catalog)."""
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator

with DAG("xen_daily", start_date=datetime(2026, 11, 1), schedule="0 2 * * *", catchup=False, max_active_runs=1,
         default_args={"retries": 2, "retry_delay": timedelta(minutes=10)}, tags=["analytics"]) as dag:
    freshness = BashOperator(task_id="source_freshness", bash_command="cd /opt/dbt && dbt source freshness")
    build = BashOperator(task_id="dbt_build", bash_command="cd /opt/dbt && dbt build --target prod")  # models + data-quality tests
    docs = BashOperator(task_id="catalog", bash_command="cd /opt/dbt && dbt docs generate")         # data catalog and lineage graph
    freshness >> build >> docs
