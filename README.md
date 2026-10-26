# Water-quality

- `pipeline_noleak.ipynb`, `water_quality_potability.csv`: water-potability modelling notebook and data.
- [`aquaq-monitor/`](aquaq-monitor/README.md): **AquaQ Monitor**, the operator web app for the autonomous
  boat and fixed-station water-quality monitoring system (Phases 1–4 complete).
- [`aquaq-monitor/planner-service/`](aquaq-monitor/planner-service/README.md): Python planner service
  (QUBO solved with simulated QAOA or a classical fallback; zone scoring).
- `aquaq-monitor/gateway/`: MQTT ↔ database bridge for the boat, with a boat emulator.
