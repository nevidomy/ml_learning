import torch.nn.functional as F
import os
from micrograd.vgrad import Var

import random
import torch
import torch.nn as nn
import torch.optim as optim

import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd().parent))

DEVICE = "mps"


import matplotlib.pyplot as plt
import seaborn as sns

from micrograd import vnet, vgrad

torch.set_printoptions(
    precision=3,      # digits after decimal
    sci_mode=False,   # disable scientific notation
    linewidth=120,    # output width
    threshold=100,   # summarize tensors larger than this
)

# Set up

NAMES = [name.strip() for name in open("names.txt", "r").readlines()]

def name_to_tensor(name):
    return torch.tensor([0]+[1 + ord(c) - ord("a") for c in name]+[0])
def tensor_to_name(tensor):
    return "".join([chr(c + ord("a")-1) for c in tensor[1:-1]])

W = torch.randn([27,27], device=DEVICE, requires_grad=True)
B = torch.randn([27], device=DEVICE, requires_grad=True)

inputX = []
inputY = []

for name in NAMES:
    t = name_to_tensor(name)
    for i in range(len(t)-1):
        inputX.append(t[i])
        inputY.append(t[i+1])

#print(inputX)
#print(inputY)

temp = 200.0
vw = torch.zeros([27,27], device=DEVICE)
vb = torch.zeros([27], device=DEVICE)
momentum_decay = 0.89

for i in range(500):
    #v = torch.tensor([F.one_hot(x, num_classes=27) for x in inputX])
    v = F.one_hot(torch.tensor(inputX, device=DEVICE), num_classes=27).float()
    R = v @ W + B
    loss = F.cross_entropy(R, torch.tensor(inputY, device=DEVICE)) + 0.0001*(W**2).mean()
    #print(R)
    #print(R.sum(dim=1))
    #if i % 100 == 0:
    print(i, loss, temp)
    W.grad = None
    B.grad = None
    loss.backward()
    with torch.no_grad():
        vw = vw * momentum_decay + W.grad
        vb = vb * momentum_decay + B.grad
        W -= temp * vw
        B -= temp * vb
    temp = max(temp * 0.89, 10)

#torch.save(W.detach(), "weights.pt")

W = W.to("cpu")
B = B.to("cpu")

def goForward(a):
    return (F.one_hot(torch.tensor(a), num_classes=27).float() @ W + B).softmax(0)

def sample_word():
    res = [0]
    a = 0
    while True:
        b = goForward(a).multinomial(num_samples=1, replacement=True).item()
        res.append(b)
        if (b == 0):
            break
        a = b
    return tensor_to_name(torch.tensor(res))

def negLogLikelihood(word):
    t = name_to_tensor(word)
    log_prob = 0.0
    for i in range(len(t)-1):
        p = goForward(t[i].item())
        log_prob += torch.log(p[t[i+1]])
    return -log_prob/(len(t) - 1)

def average_negLogLikelihood(words):
    return sum(negLogLikelihood(word) for word in words) / len(words)

print("NAMES average negLogLikelihood:", average_negLogLikelihood(NAMES))

# target: 2.460 