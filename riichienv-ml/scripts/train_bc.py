"""Train Offline BC model.

Supports standard BC (bc_logs) and ActorCriticNetwork BC (bc_model) via config.
Auto-detects mode from config's `online` flag.

DDP: either launch via torchrun (env LOCAL_RANK/RANK/WORLD_SIZE are picked up
automatically) or pass ``--world_size N`` to have the script spawn N ranks.

Usage:
    uv run python scripts/train_bc.py -c src/riichienv_ml/configs/4p/bc_logs.yml
    torchrun --nproc_per_node=2 scripts/train_bc.py -c src/riichienv_ml/configs/4p/bc_logs.yml
    uv run python scripts/train_bc.py -c src/riichienv_ml/configs/4p/bc_logs.yml --world_size 2
"""
import argparse
import os
from pathlib import Path

import torch.multiprocessing

from dotenv import load_dotenv
load_dotenv()

from riichienv_ml.config import load_config
from riichienv_ml.utils import setup_logging, init_wandb
from riichienv_ml.trainers.bc_logs import Trainer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Offline BC model")
    parser.add_argument("-c", "--config", type=str, required=True, help="Path to config YAML")
    parser.add_argument("--data_glob", type=str, default=None, help="Glob path for training data")
    parser.add_argument("--grp_model", type=str, default=None, help="Path to reward model")
    parser.add_argument("--output", type=str, default=None, help="Output model path")
    parser.add_argument("--batch_size", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--alpha", type=float, default=None, help="CQL Scale")
    parser.add_argument("--gamma", type=float, default=None)
    parser.add_argument("--num_epochs", type=int, default=None)
    parser.add_argument("--num_workers", type=int, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--num_blocks", type=int, default=None)
    parser.add_argument("--conv_channels", type=int, default=None)
    parser.add_argument("--fc_dim", type=int, default=None)
    parser.add_argument("--world_size", type=int, default=1,
                        help="Number of DDP ranks (ignored when launched via torchrun)")
    parser.add_argument("--master_port", type=str, default="29500",
                        help="TCP port for the DDP rendezvous (mp.spawn mode only)")
    return parser.parse_args()


def _init_process_group() -> int:
    """Initialize torch.distributed from torchrun env vars.

    Returns the local rank (used to select the CUDA device).
    """
    import torch.distributed as dist

    world_size = int(os.environ["WORLD_SIZE"])
    rank = int(os.environ["RANK"])
    local_rank = int(os.environ["LOCAL_RANK"])
    dist.init_process_group(
        "nccl",
        init_method="env://",
        world_size=world_size,
        rank=rank,
    )
    return local_rank


def run_training(args: argparse.Namespace, local_rank: int, ddp: bool) -> None:
    import torch.distributed as dist

    cfg = load_config(args.config).bc

    # Override config with CLI args
    overrides = {}
    for field in ["data_glob", "grp_model", "output", "batch_size", "lr", "alpha",
                  "gamma", "num_epochs", "num_workers", "limit"]:
        val = getattr(args, field, None)
        if val is not None:
            overrides[field] = val
    if overrides:
        cfg = cfg.model_copy(update=overrides)

    model_overrides = {}
    for field in ["num_blocks", "conv_channels", "fc_dim"]:
        val = getattr(args, field, None)
        if val is not None:
            model_overrides[field] = val
    if model_overrides:
        cfg = cfg.model_copy(update={"model": cfg.model.model_copy(update=model_overrides)})

    log_dir = str(Path(cfg.output).parent)
    if not ddp or local_rank == 0:
        setup_logging(log_dir, "train_bc")
        init_wandb(cfg, config_path=args.config)

    game = cfg.game

    # Online teacher BC vs offline logs BC
    if cfg.online:
        if ddp:
            raise NotImplementedError("Online teacher BC does not support DDP yet")
        from riichienv_ml.trainers.bc_model import BCModelTrainer
        trainer = BCModelTrainer(
            grp_model_path=cfg.grp_model,
            pts_weight=cfg.pts_weight,
            device_str=cfg.device,
            gamma=cfg.gamma,
            batch_size=cfg.batch_size,
            lr=cfg.lr,
            lr_min=cfg.lr_min,
            weight_decay=cfg.weight_decay,
            value_coef=cfg.value_coef,
            max_grad_norm=cfg.max_grad_norm,
            model_config=cfg.model.model_dump(),
            model_class=cfg.model_class,
            encoder_class=cfg.encoder_class,
            n_players=game.n_players,
            tile_dim=game.tile_dim,
            game_mode=game.game_mode,
            evaluator_config=cfg.evaluator,
            # Online teacher settings
            teacher_model_name=cfg.teacher_model_name,
            teacher_model_path=cfg.teacher_model_path,
            num_ray_workers=cfg.num_ray_workers,
            num_envs_per_worker=cfg.num_envs_per_worker,
            num_steps=cfg.num_steps,
            train_epochs=cfg.train_epochs,
            warmup_steps=cfg.warmup_steps,
            worker_device=cfg.worker_device,
            gpu_per_worker=cfg.gpu_per_worker,
        )
        trainer.train(cfg.output)
        return

    trainer = Trainer(
        grp_model_path=cfg.grp_model,
        pts_weight=cfg.pts_weight,
        data_glob=cfg.data_glob,
        device_str=cfg.device,
        gamma=cfg.gamma,
        batch_size=cfg.batch_size,
        lr=cfg.lr,
        alpha=cfg.alpha,
        limit=cfg.limit,
        num_epochs=cfg.num_epochs,
        num_workers=cfg.num_workers,
        weight_decay=cfg.weight_decay,
        aux_weight=cfg.aux_weight,
        model_config=cfg.model.model_dump(),
        model_class=cfg.model_class,
        dataset_class=cfg.dataset_class,
        encoder_class=cfg.encoder_class,
        n_players=game.n_players,
        replay_rule=game.replay_rule,
        tile_dim=game.tile_dim,
        evaluator_config=cfg.evaluator,
        ddp=ddp,
        local_rank=local_rank,
    )
    trainer.train(cfg.output)


def main():
    args = parse_args()

    # torchrun launches the ranks for us.
    if "LOCAL_RANK" in os.environ:
        local_rank = _init_process_group()
        try:
            run_training(args, local_rank, ddp=True)
        finally:
            import torch.distributed as dist
            dist.destroy_process_group()
        return

    # --world_size N: spawn N ranks from a single process.
    if args.world_size > 1:
        torch.multiprocessing.spawn(
            _mp_worker,
            args=(args,),
            nprocs=args.world_size,
            join=True,
        )
        return

    run_training(args, local_rank=0, ddp=False)


def _mp_worker(local_rank: int, args: argparse.Namespace) -> None:
    import torch.distributed as dist

    dist.init_process_group(
        "nccl",
        init_method=f"tcp://127.0.0.1:{args.master_port}",
        world_size=args.world_size,
        rank=local_rank,
    )
    try:
        run_training(args, local_rank=local_rank, ddp=True)
    finally:
        dist.destroy_process_group()


if __name__ == "__main__":
    torch.multiprocessing.set_start_method('spawn', force=True)
    if torch.multiprocessing.current_process().name == "MainProcess":
        main()
