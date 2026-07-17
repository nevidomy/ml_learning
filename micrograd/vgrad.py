import math
import graphviz
from numpy.core.numeric import False_

class Var:
    AUTO_LABEL = False
    auto_label_id = 100

    def __init__(self, value, label = None, children=[], _backward=None):
        self.value = value
        self.grad = 0.0
        self.children = children
        self.label = label
        if label is None and Var.AUTO_LABEL:
            self.label = f"Var_{Var.auto_label_id:04d}"
            Var.auto_label_id += 1
        self._backward = _backward
    
    def sum(values):
        values = list(values)
        res = Var(
            sum(value.value for value in values), 
            f"sum({', '.join(values.label for values in values)})" if Var.AUTO_LABEL else None,
            values)
    
        def backward():
            for value in values:
                value.grad += res.grad
        res._backward = backward
        return res

    '''
    This one is weird, if you want grad to work - provide targets, otherwise it will create 
    sql sum loss node, which would have softmaxes if needed
    '''
    def crossEntropyLoss(vars, target = None):
        total = sum(math.exp(value.value) for value in vars)
        softmaxes = [math.exp(value.value) / total for value in vars]
        res = Var(
            0 if target is None else -math.log(softmaxes[target]),
            f"softmaxLoss({vars.label})" if Var.AUTO_LABEL else None,
            vars)
        res.softMaxes = softmaxes
        def backward():
            if target is not None:
                for i in range(len(vars)):
                    vars[i].grad += res.grad * (softmaxes[i] - (1 if i == target else 0))
        res._backward = backward
        return res

    def __repr__(self):
        if self.label:
            return f"Var[{self.label}](value={self.value}, grad={self.grad})"
        return f"Var(value={self.value}, grad={self.grad})"

    def __add__(self, other):
        if isinstance(other, (float, int)):
            other = Var(other)     
        assert isinstance(other, Var), "Addition must be between two Var objects"
        return Var.sum([self, other])

    def __radd__(self, other):  
        return self + other

    def __mul__(self, other):
        if isinstance(other, (float, int)):
            other = Var(other)  
        assert isinstance(other, Var), "Multiplication must be between two Var objects"
        res = Var(
            self.value * other.value, 
            f"{self.label}*{other.label}" if Var.AUTO_LABEL else None,
            [self, other])
        def backward():
            self.grad += res.grad * other.value
            other.grad += res.grad * self.value
        res._backward = backward
        return res

    def __rmul__(self, other):
        return self * other

    def __sub__(self, other):
        if isinstance(other, (float, int)):
            other = Var(other)  
        assert isinstance(other, Var), "Subtraction must be between two Var objects"
        res = Var(
            self.value - other.value, 
            f"{self.label}-{other.label}" if Var.AUTO_LABEL else None,
            [self, other])
        def backward():
            self.grad += res.grad
            other.grad -= res.grad
        res._backward = backward
        return res

    def __rsub__(self, other):
        if isinstance(other, (float, int)):
            other = Var(other)  
        assert isinstance(other, Var), "Subtraction must be between two Var objects"
        res = Var(
            other.value - self.value, 
            f"{other.label}-{self.label}" if Var.AUTO_LABEL else None,
            [other, self])
        def backward():
            other.grad += res.grad
            self.grad -= res.grad
        res._backward = backward
        return res
    
    def __pow__(self, power):
        assert isinstance(power, (int, float)), "Power must be an integer or float"
        res = Var(
            self.value ** power, 
            f"{self.label}^{power}" if Var.AUTO_LABEL else None,
            [self])
        def backward():
            self.grad += res.grad * power * self.value ** (power - 1)
        res._backward = backward
        return res

    def __neg__(self):
        res = self * Var(
            -self.value,
            f"-{self.label}" if Var.AUTO_LABEL else None,
            [self])
        def backward():
            self.grad -= res.grad
        res._backward = res._backward
        return res

    def ln(self):
        res = Var(
            math.log(self.value), 
            f"ln({self.label})" if Var.AUTO_LABEL else None,
            [self])
        def backward():
            self.grad += res.grad / self.value
        res._backward = backward
        return res

    def tanh(self):
        res = Var(
            (math.exp(self.value) - math.exp(-self.value)) / (math.exp(self.value) + math.exp(-self.value)), 
            f"tanh({self.label})" if Var.AUTO_LABEL else None,
            [self])
        def backward():
            self.grad += res.grad * (1 - res.value**2)
        res._backward = backward
        return res  

    def topological_sort(self):
        seen = set({self})
        order = []
        def dfs(node):
            for child in node.children:
                if child not in seen:
                    seen.add(child)
                    dfs(child)
            order.append(node)
        dfs(self)
        return order

    def backward(self):
        n = 0
        self.grad = 1.0
        for node in reversed(self.topological_sort()):
            if (node._backward):
                node._backward()
                n += 1
        return f"Gradients edges: {n}"

    def zero_grad(self):
        n = 0
        for node in self.topological_sort():
            node.grad = 0.0
            n += 1
        return f"Nodes reset: {n}"

    def visualize(self):
        if (Var.AUTO_LABEL):
            dot = graphviz.Digraph()
            for node in self.topological_sort():
                dot.node(node.label, f"{node.label}: {node.value} (g={node.grad})")
                for child in node.children:
                    dot.edge(child.label, node.label)
            dot.render('graph', view=True)
        else:
            print(f"AUTO_LABLE NEED TO BE ENABLED TO VISUALIZE {node.label}: {node.value} (g={node.grad})")
            pass


'''
a = Var(-2.0, 'a')
b = Var(3.0, 'b')
d = Var(5.0, 'd')
c = (b * a - a * d).tanh()
print(c.value)

c.grad = 1.0
c.backward()
print(c.topological_sort())
c.visualize()
'''