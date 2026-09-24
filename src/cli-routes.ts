export interface CliRoute { operation:string; positionals?:string[] }

export const CLI_ROUTES:Record<string,CliRoute>={
  "activate":{operation:"workflow_activate"},"start":{operation:"workflow_start"},"checkpoint":{operation:"workflow_checkpoint"},"resume":{operation:"workflow_resume"},"close":{operation:"workflow_close"},
  "gate add":{operation:"workflow_gate_add"},"gate resolve":{operation:"workflow_gate_resolve"},"journey enter":{operation:"workflow_journey_enter",positionals:["journey"]},
  "task configure":{operation:"workflow_task_configure"},"task check":{operation:"workflow_task_check"},"capability enable":{operation:"workflow_capability_enable",positionals:["capability"]},
  "closure assess":{operation:"workflow_closure_assess"},"legacy route":{operation:"workflow_legacy_route",positionals:["name"]},
  "host recipe":{operation:"repo_host_recipe"},"host install":{operation:"repo_host_install"},"dissection assess":{operation:"repo_dissection_assess"},
  "handoff write":{operation:"repo_handoff_write"},"handoff inspect":{operation:"repo_handoff_inspect"},"coordination validate":{operation:"repo_coordination_validate"},"coordination plan":{operation:"repo_coordination_plan"},"coordination cleanup-check":{operation:"repo_coordination_cleanup_check"},"coordination cleanup":{operation:"repo_coordination_cleanup"},
  "tracker preview":{operation:"repo_tracker_preview"},
  "publication scan":{operation:"repo_publication_scan"},"context find":{operation:"repo_find_context",positionals:["query"]},"context check":{operation:"repo_context_check"},
  "context benchmark":{operation:"repo_context_benchmark"},"context impact":{operation:"repo_knowledge_impact"},"context verify":{operation:"repo_knowledge_verify"},
  "knowledge check":{operation:"repo_knowledge_bundle_check"},"knowledge build-indexes":{operation:"repo_knowledge_build_indexes"},"knowledge register":{operation:"repo_knowledge_register"},
  "documentation bootstrap":{operation:"repo_documentation_bootstrap"},"documentation assess":{operation:"repo_documentation_assess"},"documentation disposition":{operation:"repo_documentation_disposition"},"documentation apply":{operation:"repo_documentation_apply"},
  "change explain":{operation:"repo_change_explain"},"structure file-api":{operation:"repo_file_api",positionals:["path"]},"structure review":{operation:"repo_prepare_code_review",positionals:["path"]},
  "structure review-apply":{operation:"repo_record_code_review",positionals:["path"]},"structure trace":{operation:"repo_trace_symbol",positionals:["symbol"]},"structure map":{operation:"repo_structure_map"},
  "structure impact":{operation:"repo_change_impact"},"structure benchmark":{operation:"repo_structure_benchmark"},"structure search":{operation:"repo_find_all",positionals:["pattern"]},
};
