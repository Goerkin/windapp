# Databricks notebook source
# Startet oder stoppt die Windguru Databricks App. Aufgerufen aus dem Lifecycle-Job
# (resources/windguru_lifecycle.job.yml), der die App täglich 6 Uhr startet und 23 Uhr
# stoppt (Europe/Berlin) — so ist sie nur im gewünschten Fenster verfügbar (und der
# eingebaute Poller läuft nur dann).
#
# Läuft auf Serverless-Compute (kein Cluster nötig). Der Job läuft als die Person/der
# Service Principal mit CAN_MANAGE auf der App — sonst dürfen start/stop nicht.

dbutils.widgets.text("action", "start")   # start | stop
dbutils.widgets.text("app_name", "windguru")

action = dbutils.widgets.get("action").strip().lower()
app_name = dbutils.widgets.get("app_name").strip()

from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

if action == "start":
    print(f"[lifecycle] starte App {app_name!r} …")
    w.apps.start(app_name).result()
    print("[lifecycle] App läuft.")
elif action == "stop":
    print(f"[lifecycle] stoppe App {app_name!r} …")
    w.apps.stop(app_name).result()
    print("[lifecycle] App gestoppt.")
else:
    raise ValueError(f"unbekannte action {action!r} (erwartet: start|stop)")
